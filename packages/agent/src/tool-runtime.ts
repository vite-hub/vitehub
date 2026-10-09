import { agentDiagnostics } from "./agent-diagnostics.ts"
import { hasRuntimeType } from "./internal/runtime-type.ts"
import {
  formatRuntimeDiagnosticError,
  resolveCapabilityPolicy,
  ViteHubError,
} from "@vite-hub/runtime"
import { defineGrant, type Grant } from "@vite-hub/runtime/internal/grant"

import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolSet,
  AgentToolStepItem,
} from "./types.ts"

const approvalPreservingExecutorOwners = new WeakMap<Function, AgentToolPolicyOwner | null>()

function copyWithOverrides<T extends object, Overrides extends object>(tool: T, overrides: Overrides, bindExecute: boolean): Omit<T, keyof Overrides> & Overrides {
  const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(tool)
  const seen = new Set<PropertyKey>()
  // Accessors can depend on private fields or WeakMap state on the constructed instance.
  for (let owner: object | null = tool; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    const inherited = Object.getOwnPropertyDescriptors(owner)
    for (const key of Reflect.ownKeys(inherited)) {
      if (seen.has(key)) continue
      seen.add(key)
      if (Object.hasOwn(overrides, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)!
      const bindMethod = bindExecute && key === "execute"
      if (descriptor.get || descriptor.set) {
        Object.defineProperty(descriptors, key, { configurable: true, enumerable: true, writable: true, value: {
          ...descriptor,
          get: descriptor.get ? () => {
            const value: unknown = descriptor.get!.call(tool)
            return bindMethod && hasRuntimeType(value, "function") ? value.bind(tool) : value
          } : undefined,
          set: descriptor.set ? (value: unknown) => { descriptor.set!.call(tool, value) } : undefined,
        } })
      } else if (bindMethod && hasRuntimeType(descriptor.value, "function")) {
        Object.defineProperty(descriptors, key, { configurable: true, enumerable: true, writable: true, value: { ...descriptor, value: descriptor.value.bind(tool) } })
      }
  }
  }
  const copied = Object.create(Object.getPrototypeOf(tool), {
    ...descriptors,
    ...Object.getOwnPropertyDescriptors(overrides),
  })
  const policyOwner = agentToolPolicyOwners.get(tool)
  const overrideExecute = Object.getOwnPropertyDescriptor(overrides, "execute")?.value
  if (policyOwner && (!Object.hasOwn(overrides, "execute") || (hasRuntimeType(overrideExecute, "function") && approvalPreservingExecutorOwners.get(overrideExecute) === policyOwner))) {
    agentToolPolicyOwners.set(copied, policyOwner)
  }
  return copied
}

export function copyToolWithOverrides<T extends object, Overrides extends object>(tool: T, overrides: Overrides): Omit<T, keyof Overrides> & Overrides {
  return copyWithOverrides(tool, overrides, true)
}

export function copyToolMetadataWithOverrides(metadata: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  return copyWithOverrides(metadata, overrides, false)
}

function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return typeof value === "object" && value !== null && "name" in value && typeof (value as { name?: unknown }).name === "string"
}

/** Identifies one policy wrapper, so a grant cannot run a different tool with the same name. */
interface AgentToolPolicyOwner {
  readonly toolName: string
}

interface AgentToolApprovalBinding {
  input: unknown
  policy: AgentToolPolicyOwner
  requestId: string
  toolName: string
}

/** Approval requests that a policy wrapper issued and that no grant consumed yet. */
const pendingToolApproval = defineGrant("vitehub.agent.pending-tool-approval", (binding: AgentToolApprovalBinding) => binding)
/** Grants that `approveAgentToolRequest` created and that no execution consumed yet. */
const toolApproval = defineGrant("vitehub.agent.tool-approval", (binding: AgentToolApprovalBinding) => binding)

/** Proof that the user approved one tool call that a tool policy held for approval. */
export type AgentToolApprovalGrant = Grant<"vitehub.agent.tool-approval"> & { readonly requestId: string, readonly toolName: string }

/** Policy ownership propagated through wrappers around a policy-protected tool. */
const agentToolPolicyOwners = new WeakMap<object, AgentToolPolicyOwner>()
const toolApprovalGrantContextKey: unique symbol = Symbol("vitehub.agent.tool-approval-grant")

type AgentToolApprovalExecutionContext = AgentToolExecutionContext & { [toolApprovalGrantContextKey]?: AgentToolApprovalGrant }

/**
 * Create a single-use grant for an approval request that a tool policy issued.
 * Returns `undefined` when the request was not issued by a policy or already has a grant.
 */
export function approveAgentToolRequest(request: unknown): AgentToolApprovalGrant | undefined {
  if (request === null || !hasRuntimeType(request, "object")) return
  const pending = pendingToolApproval.attached(request)
  if (!pending) return
  const binding = pendingToolApproval.consume(pending)
  return toolApproval.issue(binding, { requestId: binding.requestId, toolName: binding.toolName })
}

/** Run the approved call once. The grant supplies the approved input, so the caller cannot change it. */
export async function executeApprovedAgentTool(
  tool: AgentToolDefinition,
  grant: AgentToolApprovalGrant,
  context: AgentToolExecutionContext = {},
): Promise<unknown> {
  const binding = toolApproval.check(grant)
  if (!binding || binding.toolName !== tool.name || agentToolPolicyOwners.get(tool) !== binding.policy || !tool.execute) {
    throw new ViteHubError("APPROVAL_REQUIRED", `[vitehub:runtime] Approval grant is not valid for "${tool.name}".`, {
      details: { capability: tool.name },
    })
  }
  const approvedContext: AgentToolApprovalExecutionContext = { ...context, [toolApprovalGrantContextKey]: grant }
  return await tool.execute(binding.input, approvedContext)
}

function consumeToolApprovalGrant(policy: AgentToolPolicyOwner, toolName: string, input: unknown, context: AgentToolApprovalExecutionContext | undefined): boolean {
  const grant = context?.[toolApprovalGrantContextKey]
  const binding = toolApproval.check(grant)
  if (!grant || !binding || binding.policy !== policy || binding.toolName !== toolName || binding.input !== input) return false
  toolApproval.consume(grant)
  return true
}

export function toJsonCompatibleValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  }
  catch {
    return String(value)
  }
}

function createApprovalRequest(name: string, input: unknown, reason?: string) {
  return {
    capability: name,
    id: `approval_${name}_${Math.random().toString(36).slice(2, 10)}`,
    input,
    reason,
    state: "awaiting-approval" as const,
  }
}

function withToolPolicy(tool: AgentToolDefinition): AgentToolDefinition {
  if (!tool.policy || typeof tool.execute !== "function") {
    return tool
  }

  const execute = tool.execute
  const policy = tool.policy
  const policyOwner: AgentToolPolicyOwner = Object.freeze({ toolName: tool.name })

  const approvalExecute = async (input: unknown, context?: AgentToolExecutionContext) => {
      if (consumeToolApprovalGrant(policyOwner, tool.name, input, context)) {
        context?.abortSignal?.throwIfAborted()
        return await execute.call(tool, input, context)
      }
      const decision = typeof policy === "function"
        ? await policy({
            name: tool.name,
            input,
          })
        : await resolveCapabilityPolicy(policy, {
            capability: tool.name,
            input,
            operation: "tool.execute",
          })

      if (decision === "deny") {
        throw new ViteHubError("CAPABILITY_DENIED", `[vitehub:runtime] Capability "${tool.name}" was denied.`, {
          details: { capability: tool.name },
        })
      }
      if (decision === "require-approval") {
        // Keep the execution snapshot private: callers and approval UIs can mutate their copies.
        const approvedInput = structuredClone(input)
        const approvalRequest = createApprovalRequest(tool.name, structuredClone(approvedInput))
        pendingToolApproval.attach(approvalRequest, pendingToolApproval.issue({ input: approvedInput, policy: policyOwner, requestId: approvalRequest.id, toolName: tool.name }))
        throw new ViteHubError("APPROVAL_REQUIRED", `[vitehub:runtime] Approval is required for "${tool.name}".`, {
          cause: approvalRequest,
          details: { capability: tool.name, requestId: approvalRequest.id },
          requestId: approvalRequest.id,
        })
      }
      if (decision === "retryable-failure") {
        throw agentDiagnostics.AGENT_R0003({ name: tool.name })
      }

      context?.abortSignal?.throwIfAborted()
      return await execute.call(tool, input, context)
    }
  approvalPreservingExecutorOwners.set(approvalExecute, policyOwner)
  const wrapped = copyToolWithOverrides(tool, { execute: approvalExecute })
  agentToolPolicyOwners.set(wrapped, policyOwner)
  return wrapped
}

export function applyAgentToolPolicies<TTools extends Record<string, unknown>>(tools: TTools | undefined): TTools | undefined {
  if (!tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!isAgentToolDefinition(tool)) {
      return [name, tool]
    }
    return [name, withToolPolicy(tool)]
  })) as TTools
}

export function withJsonCompatibleToolOutputs<TTools extends AgentToolSet>(tools: TTools): TTools {
  if (!tools || typeof tools !== "object") return tools

  // SAFETY: Each key and definition is preserved; execute retains its call signature while normalizing the output.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    const wrappedExecute = async (input: unknown, ...args: unknown[]) => toJsonCompatibleValue(await execute.call(tool, input, ...args))
    approvalPreservingExecutorOwners.set(wrappedExecute, agentToolPolicyOwners.get(tool) ?? null)
    return [name, copyToolWithOverrides(tool, { execute: wrappedExecute })]
  })) as TTools
}

type AgentToolStepReporter = AgentRuntimeContext["toolStepReporter"]

function createToolCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toolCallIdFromExecutionOptions(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const toolCallId = (value as { toolCallId?: unknown }).toolCallId
  return typeof toolCallId === "string" && toolCallId ? toolCallId : undefined
}

function materializeSummary(output: unknown): unknown {
  if (!output || typeof output !== "object") return output
  const result = output as {
    bytes?: unknown
    directories?: unknown
    durationMs?: unknown
    files?: unknown
    path?: unknown
    sources?: unknown
  }
  const files = typeof result.files === "number" ? result.files : 0
  const sources = Array.isArray(result.sources)
    ? result.sources.map(source => typeof source === "object" && source && "source" in source ? String((source as { source: unknown }).source) : "").filter(Boolean)
    : []
  const target = sources.length ? sources.join(" and ") : "workspace sources"
  return {
    ...result,
    summary: `Materialized ${target}${files ? ` (${files.toLocaleString()} file${files === 1 ? "" : "s"})` : ""}.`,
  }
}

export async function reportWorkspaceMaterialization(
  tools: AgentToolSet | undefined,
  reportToolStep?: AgentToolStepReporter,
): Promise<void> {
  if (!tools || typeof tools !== "object") return
  const materializeTool = (tools as Record<string, unknown>).materialize_sources
  const execute = materializeTool && typeof materializeTool === "object" && typeof (materializeTool as { execute?: unknown }).execute === "function"
    ? (materializeTool as { execute: (input: unknown) => Promise<unknown> }).execute
    : undefined
  if (!execute) return

  const toolCall: AgentToolStepItem = {
    input: { path: "" },
    toolCallId: createToolCallId("materialize_sources"),
    toolName: "materialize_sources",
  }
  await reportToolStep?.({ toolCalls: [toolCall] })
  try {
    const output = await execute.call(materializeTool, toolCall.input)
    await reportToolStep?.({ toolResults: [{ ...toolCall, output: materializeSummary(output) }] })
  }
  catch (error) {
    await reportToolStep?.({ toolErrors: [{ ...toolCall, output: formatRuntimeDiagnosticError(error) }] })
  }
}

export function withAgentToolStepReporting<TTools extends AgentToolSet>(tools: TTools, reportToolStep?: AgentToolStepReporter): TTools {
  if (!reportToolStep || !tools || typeof tools !== "object") {
    return tools
  }

  // SAFETY: Every tool key and field is preserved; execute forwards its arguments and returns the original output.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }
    if (name === "materialize_sources") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    const wrappedExecute = async (input: unknown, ...args: unknown[]) => {
        const toolCall: AgentToolStepItem = {
          input,
          toolCallId: toolCallIdFromExecutionOptions(args[0]) ?? createToolCallId(name),
          toolName: name,
        }

        await reportToolStep({ toolCalls: [toolCall] })
        try {
          const execution = args[0] as { abortSignal?: AbortSignal } | undefined
          execution?.abortSignal?.throwIfAborted()
          const output = await execute.call(tool, input, ...args)
          await reportToolStep({ toolResults: [{ ...toolCall, output }] })
          return output
        }
        catch (error) {
          await reportToolStep({ toolErrors: [{ ...toolCall, output: formatRuntimeDiagnosticError(error) }] })
          throw error
        }
      }
    approvalPreservingExecutorOwners.set(wrappedExecute, agentToolPolicyOwners.get(tool) ?? null)
    return [name, copyToolWithOverrides(tool, { execute: wrappedExecute })]
  })) as TTools
}
