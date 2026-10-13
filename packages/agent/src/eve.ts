import { ViteHubError } from "@vite-hub/runtime"

import { defineCapability } from "./capability-runtime.ts"
import { toAiSdkModelMessages } from "./ai-sdk.ts"

import type { ModelMessage } from "ai"
import type { AgentCapabilityContext, AgentCapabilityDefinition, AgentToolDefinition } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import { agentChatApprovedTools } from "./internal/chat-approvals.ts"
import { isCallableMember } from "./internal/runtime-type.ts"

interface EveApprovalContext {
  abortSignal: AbortSignal
  callId: string
  getSandbox: () => Promise<never>
  /** Accepted older Eve contracts expose this accessor. ViteHub does not mount Eve skills. */
  getSkill: (id: string) => never
  getToken: (provider: unknown, options?: unknown) => Promise<never>
  requireAuth: (provider: unknown, options?: unknown) => never
  session: {
    auth: { current: null, initiator: null }
    id: string
    turn: { id: string, sequence: number }
  }
}

interface EveApprovalRequestContext extends EveApprovalContext {
  approvedTools: ReadonlySet<string>
  toolInput: unknown
  toolName: string
}

type EveApproval = (context: EveApprovalRequestContext) => unknown | Promise<unknown>
interface EveApprovalConfiguration {
  request: EveApproval
  response?: (context: unknown) => unknown | Promise<unknown>
}

interface EveToolDefinition extends Omit<AgentToolDefinition, "execute" | "name"> {
  execute: (input: unknown, context: EveToolContext) => unknown | Promise<unknown> | AsyncIterable<unknown>
  name?: string
  approvalKey?: (input: Readonly<Record<string, unknown>>) => string
  availableInSubagents?: boolean
  endsTurn?: boolean | ((output: unknown) => boolean | Promise<boolean>)
  label?: {
    complete?: (input: unknown, output: unknown) => string
    delta?: (input: unknown, partial: unknown) => string
    start: (input: unknown) => string
  }
  approval?: EveApproval | EveApprovalConfiguration | null
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

interface EveToolContext extends EveApprovalContext {
  messages: readonly ModelMessage[]
  toolName: string
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

function approvedToolNamesFromContext(context: AgentCapabilityContext): ReadonlySet<string> {
  return agentChatApprovedTools(context, context.invocation?.input.get().context?.["chat.sessionId"])
}

function eveSessionId(context: AgentCapabilityContext): string {
  return context.run?.threadId ?? context.run?.runId ?? context.invoker.id
}

function eveTurn(context: AgentCapabilityContext): { id: string, sequence: number } {
  const id = context.run?.runId ?? eveSessionId(context)
  return {
    id,
    // ViteHub has Invocation identity, but no authoritative persisted Eve turn counter.
    get sequence() { return unsupportedEveRuntimeFeature("session.turn.sequence") },
  }
}

function eveSession(context: AgentCapabilityContext): EveToolContext["session"] {
  return {
    auth: { current: null, initiator: null },
    id: eveSessionId(context),
    turn: eveTurn(context),
  }
}

function eveLifecycleEvent(type: string, turn: EveToolContext["session"]["turn"]) {
  if (type === "session.started") return { data: {}, type }
  if (type === "step.started") return {
    data: {
      get sequence() { return turn.sequence },
      get modelId() { return unsupportedEveRuntimeFeature("step.started data.modelId") },
      get stepIndex() { return unsupportedEveRuntimeFeature("step.started data.stepIndex") },
      turnId: turn.id,
    },
    type,
  }
  return { data: { get sequence() { return turn.sequence }, turnId: turn.id }, type }
}

function unsupportedEveRuntimeFeature(name: string): never {
  throw agentDiagnostics.AGENT_R0415({ message: `[vitehub] Eve extension tools using ${name} are not supported.` })
}

function toViteHubTool(
  name: string,
  tool: EveToolDefinition,
  context: AgentCapabilityContext,
): AgentToolDefinition & Record<string, unknown> {
  const execute = tool.execute
  const toModelOutput = tool.toModelOutput
  const approval = tool.approval
  if (approval && !isCallableMember(approval) && approval.response) {
    unsupportedEveRuntimeFeature("approval.response")
  }
  const approvalRequest = isCallableMember(approval) ? approval : approval?.request
  const session = eveSession(context)
  const fallbackAbortSignal = context.abortSignal ?? context.invocation?.input.get().abortSignal ?? new AbortController().signal
  return {
    ...tool,
    name,
    ...(toModelOutput
      ? { toModelOutput: async ({ output }: { output: unknown }) => await toModelOutput(output) }
      : { toModelOutput: undefined }),
    async execute(input: unknown, options: ToolExecutionOptions = {}) {
      const callId = options.toolCallId ?? `${name}-${Date.now()}`
      const toolContext: EveToolContext = {
        abortSignal: options.abortSignal ?? fallbackAbortSignal,
        callId,
        getSandbox: async () => unsupportedEveRuntimeFeature("ctx.getSandbox()"),
        getSkill: () => unsupportedEveRuntimeFeature("ctx.getSkill()"),
        getToken: async () => unsupportedEveRuntimeFeature("ctx.getToken()"),
        requireAuth: () => unsupportedEveRuntimeFeature("ctx.requireAuth()"),
        messages: options.messages ?? toAiSdkModelMessages(context.invocation?.input.messages() ?? []),
        session,
        toolName: name,
      }
      return await execute.call(tool, input, toolContext)
    },
    ...(approvalRequest
      ? {
          async needsApproval(input: unknown, options: ToolExecutionOptions = {}) {
            const callId = options.toolCallId ?? `${name}-${Date.now()}`
            const approvedTools = approvedToolNamesFromContext(context)
            const status = await approvalRequest({
              abortSignal: options.abortSignal ?? fallbackAbortSignal,
              approvedTools,
              callId,
              getSandbox: async () => unsupportedEveRuntimeFeature("approval ctx.getSandbox()"),
              getSkill: () => unsupportedEveRuntimeFeature("approval ctx.getSkill()"),
              getToken: async () => unsupportedEveRuntimeFeature("approval ctx.getToken()"),
              requireAuth: () => unsupportedEveRuntimeFeature("approval ctx.requireAuth()"),
              session,
              toolInput: input,
              toolName: name,
            } satisfies EveApprovalRequestContext)
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
      const unsupportedEvents = events
        .map(([event]) => event)
        .filter(event => event !== "session.started" && event !== "turn.started" && event !== "step.started")
      if (unsupportedEvents.length) {
        throw agentDiagnostics.AGENT_R0419({ message: `[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} uses unsupported events: ${unsupportedEvents.join(", ")}.` })
      }
      if (events.length > 1) {
        throw agentDiagnostics.AGENT_R0419({ message: `[vitehub] Eve extension dynamic tool ${JSON.stringify(exportName)} uses unsupported events: ${events.map(([event]) => event).join(", ")}.` })
      }
      const [event, handler] = events[0] ?? []
      if (!event || !handler) continue
      const session = eveSession(context)
      const resolved = await handler(eveLifecycleEvent(event, session.turn), {
        abortSignal: context.abortSignal ?? context.invocation?.input.get().abortSignal ?? new AbortController().signal,
        channel: {
          kind: context.run?.origin,
          metadata: context.invoker.meta,
        },
        messages: toAiSdkModelMessages(context.invocation?.input.messages() ?? []),
        get model() { return event === "step.started" ? unsupportedEveRuntimeFeature("step.started context.model") : null },
        session,
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
