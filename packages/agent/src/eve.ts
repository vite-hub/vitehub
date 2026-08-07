import { ViteHubError } from "@vite-hub/runtime"

import { defineCapability } from "./capability-runtime.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"

import type { ModelMessage } from "ai"
import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentToolDefinition } from "./types.ts"

interface EveApprovalContext {
  approvedTools: ReadonlySet<string>
  callId: string
  getSandbox: () => Promise<never>
  getSkill: () => never
  session: {
    auth: { current: null, initiator: null }
    id: string
    turn: { id: string, sequence: number }
  }
  toolInput: unknown
  toolName: string
}

type EveApproval = (context: EveApprovalContext) => unknown | Promise<unknown>

interface EveToolDefinition extends AgentToolDefinition {
  approval?: EveApproval
  toModelOutput?: (output: unknown) => unknown | Promise<unknown>
}

interface EveDynamicToolDefinition {
  events: Record<string, ((event: unknown, context: unknown) => unknown | Promise<unknown>) | undefined>
  kind: "eve:dynamic"
}

interface ToolExecutionOptions {
  abortSignal?: AbortSignal
  messages?: ModelMessage[]
  toolCallId?: string
}

let extensionLoad = Promise.resolve()
const dynamicSessionTools = new WeakMap<object, Map<string, Promise<Record<string, EveToolDefinition>>>>()

function packageNamespace(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "extension"
}

async function loadMountedExtension(
  packageName: string,
  loadExtension: () => Promise<Record<string, unknown>>,
  config: unknown,
): Promise<void> {
  const previous = extensionLoad
  let release!: () => void
  extensionLoad = new Promise(resolve => release = resolve)
  await previous

  const scope = Symbol.for("eve.ext-config-scope")
  const container = globalThis as Record<symbol, unknown>
  const existingScope = container[scope]
  container[scope] = packageNamespace(packageName)
  try {
    const extension = (await loadExtension()).default
    if (typeof extension !== "function") {
      throw new TypeError(`[vitehub] Eve extension ${JSON.stringify(packageName)} must have a default factory export.`)
    }
    const mounted = extension(config) as Record<symbol, unknown>
    if (mounted?.[Symbol.for("eve.mounted-extension")] !== true) {
      throw new TypeError(`[vitehub] ${JSON.stringify(packageName)} did not return an Eve mounted extension.`)
    }
  }
  finally {
    container[scope] = existingScope
    release()
  }
}

function approvedToolNamesFromContext(context: AgentCapabilityContext): Set<string> {
  const approved = context.invocation?.input.get().context?.["vitehub.eve.approvedTools"]
  return new Set(Array.isArray(approved) ? approved.filter((name): name is string => typeof name === "string") : [])
}

function eveSessionId(context: AgentCapabilityContext): string {
  return context.run?.threadId ?? context.run?.runId ?? context.invoker.id
}

function unsupportedEveRuntimeFeature(name: string): never {
  throw new Error(`[vitehub] Eve extension tools using ${name} are not supported.`)
}

function toViteHubTool(
  name: string,
  tool: EveToolDefinition,
  context: AgentCapabilityContext,
): AgentToolDefinition & Record<string, unknown> {
  const sessionId = eveSessionId(context)
  const execute = tool.execute
  const approval = tool.approval
  return {
    ...tool,
    name,
    ...(execute
      ? {
          async execute(input: unknown, options: ToolExecutionOptions = {}) {
            const callId = options.toolCallId ?? `${name}-${Date.now()}`
            return await execute(input, {
              abortSignal: options.abortSignal ?? new AbortController().signal,
              callId,
              getSandbox: async () => unsupportedEveRuntimeFeature("ctx.getSandbox()"),
              getSkill: () => unsupportedEveRuntimeFeature("ctx.getSkill()"),
              getToken: async () => unsupportedEveRuntimeFeature("ctx.getToken()"),
              requireAuth: () => unsupportedEveRuntimeFeature("ctx.requireAuth()"),
              session: {
                auth: { current: null, initiator: null },
                id: sessionId,
                turn: { id: context.run?.runId ?? sessionId, sequence: 0 },
              },
              toolName: name,
            } as never)
          },
        }
      : {}),
    ...(approval
      ? {
          async needsApproval(input: unknown, options: ToolExecutionOptions = {}) {
            const callId = options.toolCallId ?? `${name}-${Date.now()}`
            const approvedTools = approvedToolNamesFromContext(context)
            const status = await approval({
              approvedTools,
              callId,
              getSandbox: async () => unsupportedEveRuntimeFeature("approval ctx.getSandbox()"),
              getSkill: () => unsupportedEveRuntimeFeature("approval ctx.getSkill()"),
              session: {
                auth: { current: null, initiator: null },
                id: sessionId,
                turn: { id: context.run?.runId ?? sessionId, sequence: 0 },
              },
              toolInput: input,
              toolName: name,
            })
            const decision = typeof status === "object" && status && "type" in status
              ? status.type
              : status === true
                ? "user-approval"
                : status === false || status === undefined
                  ? "not-applicable"
                  : status
            if (decision === "denied") {
              throw new ViteHubError("CAPABILITY_DENIED", `[vitehub] Eve extension tool ${JSON.stringify(name)} was denied.`)
            }
            if (decision === "user-approval") return true
            if (decision === "approved" || decision === "not-applicable") return false
            throw new TypeError(`[vitehub] Eve extension tool ${JSON.stringify(name)} returned an unsupported approval decision.`)
          },
        }
      : {}),
  }
}

function isEveTool(value: unknown): value is EveToolDefinition {
  return typeof value === "object" && value !== null && typeof (value as EveToolDefinition).execute === "function"
}

function isEveDynamicTool(value: unknown): value is EveDynamicToolDefinition {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "eve:dynamic"
}

function addEveTool(
  tools: Record<string, AgentToolDefinition>,
  namespace: string,
  name: string,
  value: unknown,
  context: AgentCapabilityContext,
): void {
  if (!isEveTool(value)) {
    throw new TypeError(`[vitehub] Eve extension tool ${JSON.stringify(name)} is not a supported tool definition.`)
  }
  const toolName = `${namespace}__${name}`
  if (tools[toolName]) throw new Error(`[vitehub] Duplicate Eve extension tool ${JSON.stringify(toolName)}.`)
  tools[toolName] = toViteHubTool(toolName, value, context)
}

async function resolveEveTools(
  namespace: string,
  module: Record<string, unknown>,
  context: AgentCapabilityContext,
): Promise<Record<string, AgentToolDefinition>> {
  const tools: Record<string, AgentToolDefinition> = {}
  for (const [exportName, exported] of Object.entries(module)) {
    if (isEveDynamicTool(exported)) {
      const events = Object.entries(exported.events)
        .filter(([, handler]) => typeof handler === "function")
        .map(([event]) => event)
      if (events.some(event => event !== "session.started")) {
        throw new Error(`[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} uses unsupported events: ${events.join(", ")}.`)
      }
      let sessions = dynamicSessionTools.get(module)
      if (!sessions) {
        sessions = new Map()
        dynamicSessionTools.set(module, sessions)
      }
      const sessionId = eveSessionId(context)
      const cacheKey = JSON.stringify([sessionId, exportName])
      let resolving = sessions.get(cacheKey)
      if (!resolving) {
        // ponytail: Agent Sessions do not expose an end hook yet; move cleanup there when they do.
        resolving = (async () => {
          const handler = exported.events["session.started"]
          const resolved = await handler?.({ type: "session.started" }, {
            channel: {
              kind: context.run?.origin,
              metadata: context.invoker.meta,
            },
            messages: toAiSdkModelMessages(context.invocation?.input.messages() ?? []),
            session: {
              auth: { current: null, initiator: null },
              id: sessionId,
            },
          })
          if (resolved === null || resolved === undefined) return {}
          if (isEveTool(resolved)) return { [exportName]: resolved }
          if (typeof resolved === "object") return resolved as Record<string, EveToolDefinition>
          throw new TypeError(`[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} returned an unsupported value.`)
        })()
        sessions.set(cacheKey, resolving)
        void resolving.catch(() => sessions!.delete(cacheKey))
      }
      for (const [name, tool] of Object.entries(await resolving)) addEveTool(tools, namespace, name, tool, context)
      continue
    }
    addEveTool(tools, namespace, exportName, exported, context)
  }
  return tools
}

export async function eveExtensionCapability(
  packageName: string,
  namespace: string,
  loadExtension: () => Promise<Record<string, unknown>>,
  loadTools: () => Promise<Record<string, unknown>>,
  config?: unknown,
): Promise<AgentCapabilityDefinition> {
  await loadMountedExtension(packageName, loadExtension, config)
  const tools = await loadTools()
  return defineCapability({
    id: `eve.${namespace}`,
    metadata: { kind: "eve-extension", packageName },
    tools: context => resolveEveTools(namespace, tools, context),
  })
}
