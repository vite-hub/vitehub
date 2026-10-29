import { installedOperationRegistry, installedOperationSectionResolver, operationAccessAllows, operationCall, operationInputJsonSchema, parseOperationInput, runParsedOperation, toOperationFailure } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { agentDiagnostics } from "../agent-diagnostics.ts"
import { defineCapability } from "../capability-runtime.ts"
import { isRuntimeRecord } from "../internal/runtime-type.ts"
import { defineInternalTool, primitiveHandle } from "./internal.ts"

import type { AnyOperation, OperationKind, OperationRegistry, OperationResult, OperationUser } from "@vite-hub/internal/operations"
import type { AgentActor, AgentCapabilityContext, AgentCapabilityDefinition, AgentToolPolicyDecision, AgentToolSet, MaybePromise } from "../types.ts"

/** Which operations need approval before an Agent runs them. */
export type OperationsApproval = "all" | "destructive" | "never" | "write" | readonly string[] | ((operation: { kind: OperationKind, name: string }) => boolean)

export interface OperationsCapabilityOptions {
  /** Operation names, or a section with a star, such as `content.*`. `*` exposes every operation. */
  include: readonly string[]
  /** Operations that wait for approval. Default: `write`. */
  approve?: OperationsApproval
  /**
   * Map the Invocation's Actor to the user that the operations see. Default: the Auth user the Actor stands for when Auth
   * is configured, otherwise null.
   */
  user?: (actor: AgentActor) => MaybePromise<OperationUser | null | undefined>
  /**
   * Let the Agent pass `lease: "override"` to `content.save`, so it can write over a document that a person is
   * editing. Default: false.
   */
  overrideLeases?: boolean
  /**
   * What the Agent may read of the Channel conversations (`channels.threads`, `channels.conversation`,
   * `conversations.export`). Unset: nothing, and those operations refuse. `"participant"`: the threads that the Actor
   * takes part in, matched by the Actor id, its Auth user id, or the id of a person in the thread. `"all"`: every
   * thread that a Channel knows. `conversations.export` always waits for approval and never includes media.
   */
  conversations?: "all" | "participant"
  /** The operations to use. Default: the ones the app installed. Tests pass their own. */
  registry?: OperationRegistry
}

const optionsSchema = v.object({
  conversations: v.optional(v.picklist(["all", "participant"])),
  approve: v.optional(v.union([v.picklist(["all", "destructive", "never", "write"]), v.array(v.string()), v.custom<(operation: { kind: OperationKind, name: string }) => boolean>(value => value instanceof Function)])),
  include: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  overrideLeases: v.optional(v.boolean()),
  registry: v.optional(v.custom<OperationRegistry>(value => isRuntimeRecord(value) && value.get instanceof Function && value.list instanceof Function)),
  user: v.optional(v.custom<NonNullable<OperationsCapabilityOptions["user"]>>(value => value instanceof Function)),
})

function matches(pattern: string, name: string): boolean {
  if (pattern === "*") return true
  return pattern.endsWith(".*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name
}

function needsApproval(approve: OperationsApproval, operation: Pick<AnyOperation, "kind" | "name">): boolean {
  // An export copies a whole conversation out of the app, so a person confirms it, as for a write.
  if (operation.name === "conversations.export" && approve !== "never") return true
  if (approve === "all") return true
  if (approve === "never") return false
  if (approve === "write") return operation.kind !== "read"
  if (approve === "destructive") return operation.kind === "destructive"
  return approve instanceof Function ? approve(operation) : approve.includes(operation.name)
}

/** The tool name of an operation: dots become underscores, since providers reject dots. */
export function operationToolName(name: string): string {
  return name.replace(/\./g, "_")
}

/** The Auth user as an operation user. A value without an id is no user. */
function operationUser(value: unknown): OperationUser | null {
  return isRuntimeRecord(value) && String(value.id) === value.id ? { ...value, id: value.id } : null
}

async function authUser(context: AgentCapabilityContext): Promise<OperationUser | null> {
  const auth = primitiveHandle(context, "auth")
  if (!context.actor || !isRuntimeRecord(auth) || !(auth.user instanceof Function)) return null
  return operationUser(await auth.user(context.actor))
}

async function operationTools(context: AgentCapabilityContext, options: { approve: OperationsApproval, conversations?: "all" | "participant", include: readonly string[], overrideLeases: boolean, registry?: OperationRegistry, user?: OperationsCapabilityOptions["user"] }): Promise<AgentToolSet> {
  const registry = options.registry ?? installedOperationRegistry()
  if (!registry) {
    throw agentDiagnostics.AGENT_R1014({ message: "[vitehub] operations() found no operations. The app installs them when its server starts, with the Console plugin that `vite dev` and `console` add." })
  }
  for (const pattern of options.include) {
    if (!registry.list().some(operation => matches(pattern, operation.name))) {
      throw agentDiagnostics.AGENT_R1014({ message: `[vitehub] operations({ include }) names ${JSON.stringify(pattern)}, which matches no operation of this app.` })
    }
  }
  // The operations see the user that the Actor stands for. `console.authorize` decides which sections that user may use.
  const user = options.user && context.actor ? operationUser(await options.user(context.actor)) : await authUser(context)
  const sections = await installedOperationSectionResolver()?.({ ...(context.actor ? { actor: context.actor } : {}), user }) ?? "all"
  // No sections means the policy denied admission, including sectionless and dynamic operations.
  if (sections !== "all" && sections.length === 0) return {}
  const access = { mode: "agent", sections, ...(user ? { user } : {}) }
  const selected = registry.list()
    .filter(operation => options.include.some(pattern => matches(pattern, operation.name)))
    // An operation that reads its section from the input is checked again when it runs. A read-only grant keeps the
    // operations that read, and the ones with a dry run.
    .filter(operation => typeof operation.section === "function" || operationAccessAllows(access, operation.section, { kind: operation.kind, readOnly: operation.readOnlyWhen !== undefined }))
  const tools: AgentToolSet = {}
  for (const operation of selected) {
    const approval: AgentToolPolicyDecision = needsApproval(options.approve, operation) ? "require-approval" : "allow"
    // Keep an allowed dry run's parsed input until execution. Re-parsing could change a default or transform.
    const parsedInputs = new Map<unknown, Promise<unknown>>()
    tools[operationToolName(operation.name)] = defineInternalTool({
      description: operation.description,
      execute: async (input) => {
        let result: OperationResult
        try {
          const parsed = await (parsedInputs.get(input) ?? parseOperationInput(operation, input))
          result = await runParsedOperation(operation, parsed, {
            access,
            ...(context.actor ? { actor: context.actor } : {}),
            ...(options.overrideLeases ? { overrideLeases: true } : {}),
            ...(options.conversations ? { conversations: options.conversations } : {}),
            surface: "agent",
            user,
          })
        }
        catch (error) {
          result = { ok: false, ...toOperationFailure(error) }
        }
        finally {
          parsedInputs.delete(input)
        }
        if (result.ok) return result.value
        // Input, access, and conflict failures are results the model can act on. Server failures stay errors.
        if (result.status < 500) return { error: { code: result.code, ...(result.details ? { details: result.details } : {}), ...(result.fix ? { fix: result.fix } : {}), message: result.message }, ok: false as const }
        throw Object.assign(new Error(result.message), { code: result.code })
      },
      inputSchema: operationInputJsonSchema(operation),
      metadata: { operations: { kind: operation.kind, name: operation.name } },
      name: operationToolName(operation.name),
      // A call that only reads, such as a dry run, needs no approval.
      policy: approval === "allow" || !operation.readOnlyWhen ? approval : async ({ input }) => {
        const parsed = parseOperationInput(operation, input)
        try {
          if (!operationCall(operation, await parsed).readOnly) return approval
        }
        catch {
          // Execution returns the shared coded input failure without asking to approve an invalid call.
        }
        parsedInputs.set(input, parsed)
        return "allow"
      },
      title: operation.description,
    })
  }
  return tools
}

/**
 * Tools for the operations of the app, such as `content.*`. Each operation becomes a tool named after it, with dots as
 * underscores (`content.publish` is `content_publish`). The operations see the Auth user that the Actor stands for.
 * `console.authorize` runs for that user (with a request that has no headers) and decides which Console sections it may
 * use: an operation of another section is not offered. An app without `console.authorize` has no such filter, so the
 * `include` list is the only gate. Write and destructive operations wait for approval unless `approve` says otherwise, and a
 * dry run (`readOnlyWhen`) never waits.
 */
export function operations(options: OperationsCapabilityOptions): AgentCapabilityDefinition {
  const parsed = v.safeParse(optionsSchema, options)
  if (!parsed.success) throw agentDiagnostics.AGENT_C0013()
  const { approve = "write", conversations, include, overrideLeases = false, registry, user } = parsed.output as typeof parsed.output & Pick<OperationsCapabilityOptions, "registry" | "user">
  return defineCapability({
    id: "operations",
    metadata: { approve: typeof approve === "string" ? approve : Array.isArray(approve) ? approve : "custom", ...(conversations ? { conversations } : {}), include: [...include] },
    mode: "write",
    tools: context => operationTools(context, { approve, ...(conversations ? { conversations } : {}), include, overrideLeases, registry, user }),
  })
}
