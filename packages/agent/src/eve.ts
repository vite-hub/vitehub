import { ViteHubError } from "@vite-hub/runtime"

import { defineCapability } from "./capability-runtime.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"

import type { ModelMessage } from "ai"
import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentToolDefinition } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"

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

async function loadMountedExtension(
  packageName: string,
  namespace: string,
  loadExtension: () => Promise<Record<string, unknown>>,
  config: unknown,
): Promise<void> {
  const previous = extensionLoad
  let release!: () => void
  extensionLoad = new Promise(resolve => release = resolve)
  await previous

  const scope = Symbol.for("eve.ext-config-scope")
  // SAFETY: Eve owns this symbol-keyed global configuration bridge and restores its prior value below.
  const container = globalThis as Record<symbol, unknown>
  const existingScope = container[scope]
  container[scope] = namespace
  try {
    const extension = (await loadExtension()).default
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Extension modules are external input and the factory contract must be checked before invocation.
    if (typeof extension !== "function") {
      throw agentDiagnostics.AGENT_R0413({ message: `[vitehub] Eve extension ${JSON.stringify(packageName)} must have a default factory export.` })
    }
    // SAFETY: The mounted-extension symbol check below validates the only mounted value property ViteHub consumes.
    const mounted = extension(config) as Record<symbol, unknown>
    if (mounted?.[Symbol.for("eve.mounted-extension")] !== true) {
      throw agentDiagnostics.AGENT_R0414({ message: `[vitehub] ${JSON.stringify(packageName)} did not return an Eve mounted extension.` })
    }
  }
  finally {
    container[scope] = existingScope
    release()
  }
}

function approvedToolNamesFromContext(context: AgentCapabilityContext): Set<string> {
  const approved = context.invocation?.input.get().context?.["vitehub.eve.approvedTools"]
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Invocation context is external input and approved tool names must be strings.
  return new Set(Array.isArray(approved) ? approved.filter((name): name is string => typeof name === "string") : [])
}

function eveSessionId(context: AgentCapabilityContext): string {
  return context.run?.runId ?? context.run?.threadId ?? context.invoker.id
}

function unsupportedEveRuntimeFeature(name: string): never {
  throw agentDiagnostics.AGENT_R0415({ message: `[vitehub] Eve extension tools using ${name} are not supported.` })
}

function toViteHubTool(
  name: string,
  tool: EveToolDefinition,
  context: AgentCapabilityContext,
): AgentToolDefinition & Record<string, unknown> {
  const sessionId = eveSessionId(context)
  const execute = tool.execute
  const toModelOutput = tool.toModelOutput
  const approval = tool.approval
  return {
    ...tool,
    name,
    ...(toModelOutput
      ? { toModelOutput: async ({ output }: { output: unknown }) => await toModelOutput(output) }
      : { toModelOutput: undefined }),
    ...(execute
      ? {
          async execute(input: unknown, options: ToolExecutionOptions = {}) {
            const callId = options.toolCallId ?? `${name}-${Date.now()}`
            // SAFETY: This adapter supplies Eve's documented execution context while unsupported members throw explicitly.
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
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Eve approval callbacks may return a decision object or a legacy scalar.
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
            throw agentDiagnostics.AGENT_R0416({ message: `[vitehub] Eve extension tool ${JSON.stringify(name)} returned an unsupported approval decision.` })
          },
        }
      : undefined),
  }
}

function isEveTool(value: unknown): value is EveToolDefinition {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Eve tool exports cross a package boundary and require runtime shape validation.
  // SAFETY: The record assertion only reads the execute discriminator used to establish EveToolDefinition.
  return typeof value === "object" && value !== null && typeof (value as EveToolDefinition).execute === "function"
}

function isEveDynamicTool(value: unknown): value is EveDynamicToolDefinition {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Eve dynamic exports cross a package boundary and require runtime shape validation.
  // SAFETY: The record assertion only reads the kind discriminator used to establish EveDynamicToolDefinition.
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
    throw agentDiagnostics.AGENT_R0417({ message: `[vitehub] Eve extension tool ${JSON.stringify(name)} is not a supported tool definition.` })
  }
  const toolName = `${namespace}__${name}`
  if (tools[toolName]) throw agentDiagnostics.AGENT_R0418({ message: `[vitehub] Duplicate Eve extension tool ${JSON.stringify(toolName)}.` })
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
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Eve event handlers are external extension exports and must be callable.
        .filter(([, handler]) => typeof handler === "function")
        .map(([event]) => event)
      if (events.some(event => event !== "session.started" && event !== "step.started") || events.length > 1) {
        throw agentDiagnostics.AGENT_R0419({ message: `[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} uses unsupported events: ${events.join(", ")}.` })
      }
      const event = events[0]
      if (!event) continue
      const sessionId = eveSessionId(context)
      const handler = exported.events[event]
      const resolved = await handler?.({ type: event }, {
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
      if (resolved === null || resolved === undefined) continue
      if (isEveTool(resolved)) {
        addEveTool(tools, namespace, exportName, resolved, context)
        continue
      }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Dynamic extension output must be validated before enumerating its tools.
      if (typeof resolved !== "object") {
        throw agentDiagnostics.AGENT_R0420({ message: `[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} returned an unsupported value.` })
      }
      // SAFETY: isEveTool validates every enumerated value before it enters the ViteHub tool registry.
      for (const [name, tool] of Object.entries(resolved as Record<string, EveToolDefinition>)) {
        addEveTool(tools, namespace, name, tool, context)
      }
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
  await loadMountedExtension(packageName, namespace, loadExtension, config)
  const tools = await loadTools()
  return defineCapability({
    id: `eve.${namespace}`,
    metadata: { kind: "eve-extension", packageName },
    tools: context => resolveEveTools(namespace, tools, context),
  })
}
