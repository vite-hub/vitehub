import { getMessageText } from "./messages.ts"
import { jsonSchema } from "ai"
import {
  cloneWithPropertyDescriptors,
  teeingAsyncIterableStreamDescriptor,
} from "./internal/stream-result.ts"
import {
  applyCapabilityInstructionSlots,
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import { applyWorkspaceSourceInstructionSlot } from "./workspace-agent.ts"
import {
  applyAgentToolPolicies,
  reportWorkspaceMaterialization,
  withAgentToolStepReporting,
  withJsonCompatibleToolOutputs,
  toJsonCompatibleValue,
} from "./tool-runtime.ts"
import {
  aiSdkTelemetryIntegration,
  hasAgentTraceLog,
} from "./trace.ts"

import type {
  Agent,
  AssistantContent,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  ToolContent,
  ToolLoopAgentSettings,
  ToolResultPart,
  ToolSet,
} from "ai"
import type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentModelExecutionOptions,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentToolResolverWithWorkspace,
  MaybePromise,
} from "./types.ts"
import type { Message, MessagePart } from "./messages.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export interface AiSdkAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
  Name extends WorkspaceName = WorkspaceName,
> {
  execution?: AiSdkModelExecutionOptions<TRuntimeConfig, TCallOptions, TTools>
  instructions?: AgentAdapterInstructions<TRuntimeConfig, Name>
  modelExecution?: AiSdkModelExecutionOptions<TRuntimeConfig, TCallOptions, TTools>
  model: ToolLoopAgentSettings<TCallOptions, TTools>["model"] | ((context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => MaybePromise<ToolLoopAgentSettings<TCallOptions, TTools>["model"]>)
  tools?: AgentToolResolverWithWorkspace<TRuntimeConfig, Name>
}

export type AiSdkModelCallSettings<
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
> = Omit<ToolLoopAgentSettings<TCallOptions, TTools>, "instructions" | "model" | "tools">

export type AiSdkModelExecutionOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
> = Omit<AgentModelExecutionOptions<TRuntimeConfig, TCallOptions>, "callSettings" | "workspaceFallback"> & {
  callSettings?: AiSdkModelCallSettings<TCallOptions, TTools>
  workspaceFallback?: boolean | AiSdkWorkspaceFallbackOptions
}

export interface AiSdkWorkspaceFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

function toTextModelMessageContent(parts: MessagePart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "error") return part.error
    if (part.type === "data") return JSON.stringify(part.data)
    if (part.type === "tool-call") return JSON.stringify({ input: part.input, toolCallId: part.id, toolName: part.name, type: "tool-call" })
    if (part.type === "tool-result") return JSON.stringify({ error: part.error, output: part.output, toolCallId: part.id, toolName: part.name, type: "tool-result" })
    if (part.type === "approval-request") return JSON.stringify({ input: part.input, reason: part.reason, toolCallId: part.id, toolName: part.name, type: "approval-request" })
    if (part.type === "approval-decision") return JSON.stringify({ approved: part.approved, reason: part.reason, toolCallId: part.id, type: "approval-decision" })
    if (part.type === "source") return part.url || part.title || ""
    return ""
  }).filter(Boolean).join("\n")
}

type AssistantContentPart = Exclude<AssistantContent, string>[number]
type ToolContentPart = ToolContent[number]

function toToolResultOutput(part: Extract<MessagePart, { type: "tool-result" }>): ToolResultPart["output"] {
  if (part.error) {
    return { type: "error-text", value: part.error } as ToolResultPart["output"]
  }
  const output = part.output ?? null
  if (typeof output === "string") {
    return { type: "text", value: output } as ToolResultPart["output"]
  }
  return { type: "json", value: toJsonCompatibleValue(output) } as ToolResultPart["output"]
}

function toToolResultModelPart(part: Extract<MessagePart, { type: "tool-result" }>): ToolResultPart {
  return {
    output: toToolResultOutput(part),
    toolCallId: part.id,
    toolName: part.name,
    type: "tool-result",
  }
}

function toApprovalResponseModelPart(part: Extract<MessagePart, { type: "approval-decision" }>): ToolContentPart {
  return {
    approvalId: part.id,
    approved: part.approved,
    reason: part.reason,
    type: "tool-approval-response",
  }
}

function toAssistantModelMessagePart(part: MessagePart): AssistantContentPart | undefined {
  if (part.type === "text") {
    return { text: part.text, type: "text" as const }
  }
  if (part.type === "tool-call") {
    return {
      input: part.input ?? {},
      toolCallId: part.id,
      toolName: part.name,
      type: "tool-call" as const,
    }
  }
  if (part.type === "approval-request") {
    return {
      approvalId: part.id,
      toolCallId: part.id,
      type: "tool-approval-request" as const,
    }
  }
}

function pushAssistantModelMessage(messages: ModelMessage[], content: AssistantContentPart[]): void {
  if (content.length) {
    messages.push({ content, role: "assistant" })
  }
}

function pushToolModelMessage(messages: ModelMessage[], content: ToolContent): void {
  if (content.length) {
    messages.push({ content, role: "tool" })
  }
}

function toAssistantModelMessages(parts: MessagePart[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  let assistantContent: AssistantContentPart[] = []
  let toolContent: ToolContent = []

  for (const part of parts) {
    if (part.type === "tool-result") {
      pushAssistantModelMessage(messages, assistantContent)
      assistantContent = []
      toolContent.push(toToolResultModelPart(part))
      continue
    }
    if (part.type === "approval-decision") {
      pushAssistantModelMessage(messages, assistantContent)
      assistantContent = []
      toolContent.push(toApprovalResponseModelPart(part))
      continue
    }
    const assistantPart = toAssistantModelMessagePart(part)
    if (assistantPart) {
      pushToolModelMessage(messages, toolContent)
      toolContent = []
      assistantContent.push(assistantPart)
    }
  }

  pushAssistantModelMessage(messages, assistantContent)
  pushToolModelMessage(messages, toolContent)
  if (messages.length) return messages

  const content = toTextModelMessageContent(parts)
  return hasModelMessageContent(content)
    ? [{ content, role: "assistant" }]
    : []
}

function toToolModelMessageContent(parts: MessagePart[]): ToolContent {
  const content: ToolContent = []

  for (const part of parts) {
    if (part.type === "tool-result") {
      content.push(toToolResultModelPart(part))
    }
    if (part.type === "approval-decision") {
      content.push(toApprovalResponseModelPart(part))
    }
  }

  return content
}

export function toAiSdkModelMessages(messages: Message[]): ModelMessage[] {
  return messages
    .flatMap((message): ModelMessage[] => {
      if (message.role === "assistant") {
        return toAssistantModelMessages(message.parts)
      }
      if (message.role === "tool") {
        const content = toToolModelMessageContent(message.parts)
        return hasModelMessageContent(content)
          ? [{ content, role: message.role } as ModelMessage]
          : []
      }
      const content = getMessageText(message) || toTextModelMessageContent(message.parts)
      return hasModelMessageContent(content)
        ? [{ content, role: message.role } as ModelMessage]
        : []
    })
}

function hasModelMessageContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  return Array.isArray(content) ? content.length > 0 : content != null
}

function getCallInput(context: AgentAdapterRunContext) {
  const base = {
    abortSignal: context.input.abortSignal,
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
    return {
      ...base,
      messages: toAiSdkModelMessages(context.messages),
    }
  }
  if (context.prompt) {
    return {
      ...base,
      prompt: context.prompt,
    }
  }
  return {
    ...base,
    messages: [],
  }
}

function getFallbackOptions(fallback: AiSdkModelExecutionOptions["workspaceFallback"]): Required<AiSdkWorkspaceFallbackOptions> {
  if (fallback === false) return { enabled: false, maxToolResults: 0 }
  if (fallback === true || fallback === undefined) return { enabled: true, maxToolResults: 8 }
  return {
    enabled: fallback.enabled ?? true,
    maxToolResults: fallback.maxToolResults ?? 8,
  }
}

function collectToolResults(
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const parts: string[] = []

  for (const step of result.steps || []) {
    for (const output of collectToolResultOutputs(step)) {
      parts.push(JSON.stringify(output).slice(0, 4000))
      if (parts.length >= maxToolResults) return parts
    }
  }

  return parts
}

function hasToolResults(result: { steps?: Array<{ content?: Array<{ type: string }> }> }) {
  return result.steps?.some(step => collectToolResultOutputs(step).length > 0) || false
}

function getPromptText(context: AgentAdapterRunContext) {
  if (context.prompt) return context.prompt
  const latestUserMessage = [...context.messages].reverse().find(message => message.role === "user")
  return latestUserMessage ? getMessageText(latestUserMessage) : ""
}

async function synthesizeWorkspaceFallback(
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const evidence = collectToolResults(result, maxToolResults)
  return await synthesizeWorkspaceFallbackFromEvidence(model, context, evidence)
}

async function synthesizeWorkspaceFallbackFromEvidence(
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  evidence: string[],
) {
  if (evidence.length === 0) return undefined

  const { generateText } = await import("ai")
  const summary = await generateText({
    model,
    system: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
    ].join("\n"),
    prompt: [
      `User message:\n${getPromptText(context)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

function createWorkspaceFallbackEvidenceCapture(maxToolResults: number) {
  const evidence: string[] = []

  return {
    collect(event: unknown) {
      for (const output of collectToolResultOutputs(event)) {
        if (evidence.length >= maxToolResults) break
        evidence.push(JSON.stringify(output).slice(0, 4000))
      }
    },
    evidence() {
      return evidence.slice()
    },
  }
}

function streamEventText(event: unknown): string | undefined {
  if (typeof event === "string") return event
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { delta?: unknown, text?: unknown, textDelta?: unknown, type?: unknown }
  if (record.type !== "text-delta" && record.type !== "text") return undefined
  const text = record.text ?? record.textDelta ?? record.delta
  return typeof text === "string" ? text : undefined
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function pushDefinedOutput(outputs: unknown[], output: unknown): void {
  if (output !== undefined) outputs.push(output)
}

function collectToolResultOutputs(value: unknown): unknown[] {
  const record = recordFrom(value)
  if (!record) return []
  const type = typeof record.type === "string" ? record.type : undefined
  const outputs: unknown[] = []

  if (type === "tool-result" || type === "tool-output-available") {
    pushDefinedOutput(outputs, record.output ?? record.result)
  }
  if (type === "tool-error" || type === "tool-output-error") {
    pushDefinedOutput(outputs, record.error ?? record.errorText ?? record.output ?? record.result)
  }

  for (const key of ["content", "toolResults", "tool_outputs", "toolOutputs"]) {
    const items = record[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const itemRecord = recordFrom(item)
      if (!itemRecord) continue
      if (key === "toolResults" || key === "tool_outputs" || key === "toolOutputs") {
        pushDefinedOutput(outputs, itemRecord.output ?? itemRecord.result ?? itemRecord.error ?? itemRecord.errorText)
        continue
      }
      outputs.push(...collectToolResultOutputs(itemRecord))
    }
  }

  const stepOutputs = collectToolResultOutputs(record.step)
  if (stepOutputs.length) outputs.push(...stepOutputs)

  return outputs
}

function streamToolResultOutputs(event: unknown): unknown[] {
  if (typeof event !== "object" || event === null) return []
  return collectToolResultOutputs(event)
}

function streamEventType(event: unknown): string | undefined {
  return typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string"
    ? (event as { type: string }).type
    : undefined
}

function workspaceFallbackFinishEvent(finishEvent: unknown): unknown {
  return typeof finishEvent === "object" && finishEvent !== null
    ? { ...finishEvent, finishReason: "workspace-fallback", type: "finish" }
    : { finishReason: "workspace-fallback", type: "finish" }
}

function finishEventReason(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { finishReason?: unknown, reason?: unknown }
  const reason = record.finishReason ?? record.reason
  return typeof reason === "string" ? reason : undefined
}

function workspaceFallbackTextEvents(text: string): unknown[] {
  const id = "workspace-fallback"
  return [
    { id, type: "text-start" },
    { id, text, type: "text-delta" },
    { id, type: "text-end" },
  ]
}

function cloneStreamTextResult<T extends object>(result: T, fullStream: AsyncIterable<unknown>): T {
  return cloneWithPropertyDescriptors(result, {
    fullStream: teeingAsyncIterableStreamDescriptor(fullStream),
  })
}

function withWorkspaceFallbackFullStream(
  stream: AsyncIterable<unknown>,
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  maxToolResults: number,
  capturedEvidence?: () => string[],
): AsyncIterable<unknown> {
  return (async function* () {
    let text = ""
    let textAfterLastToolResult = ""
    const evidence: string[] = []
    let finishEvent: unknown

    for await (const event of stream) {
      const eventText = streamEventText(event) || ""
      text += eventText
      textAfterLastToolResult += eventText
      const outputs = streamToolResultOutputs(event)
      for (const output of outputs) {
        if (evidence.length >= maxToolResults) break
        evidence.push(JSON.stringify(output).slice(0, 4000))
        textAfterLastToolResult = ""
      }
      const type = streamEventType(event)
      if (type === "finish" || type === "abort") {
        finishEvent = event
        continue
      }
      yield event
    }

    const fallbackEvidence = evidence.length ? evidence : capturedEvidence?.() ?? []
    const hasFinalText = evidence.length
      ? textAfterLastToolResult.trim()
      : fallbackEvidence.length
        ? ""
        : text.trim()
    if ((hasFinalText && finishEventReason(finishEvent) !== "tool-calls") || fallbackEvidence.length === 0) {
      if (finishEvent) yield finishEvent
      return
    }

    const synthesized = await synthesizeWorkspaceFallbackFromEvidence(model, context, fallbackEvidence)
    if (synthesized) {
      yield* workspaceFallbackTextEvents(synthesized)
      yield workspaceFallbackFinishEvent(finishEvent)
      return
    }
    if (finishEvent) yield finishEvent
  })()
}

function withWorkspaceFallbackStreamResult<T extends { fullStream?: AsyncIterable<unknown> }>(
  result: T,
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  fallback: Required<AiSdkWorkspaceFallbackOptions>,
  capturedEvidence?: () => string[],
): T {
  if (!fallback.enabled || !result.fullStream) return result
  return cloneStreamTextResult(result as object, withWorkspaceFallbackFullStream(result.fullStream, model, context, fallback.maxToolResults, capturedEvidence)) as T
}

async function resolveValue<T>(value: T | ((context: AgentAdapterMetadataContext) => MaybePromise<T>), context: AgentAdapterMetadataContext): Promise<T> {
  return typeof value === "function" ? await (value as (context: AgentAdapterMetadataContext) => MaybePromise<T>)(context) : value
}

function joinInstructions(...parts: Array<AgentAdapterInstructionsValue | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function resolveInstructions(options: AiSdkAdapterOptions, context: AgentAdapterMetadataContext) {
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(context)
    : part))

  return joinInstructions(...instructions)
}

async function resolveTools(options: AiSdkAdapterOptions, context: AgentAdapterMetadataContext, reportToolStep?: AgentAdapterRunContext["devtools"] extends infer T ? T extends { reportToolStep?: infer R } ? R : never : never) {
  if (!options.tools) return undefined
  const resolved = await resolveValue(options.tools as never, context)
  const tools = withJsonCompatibleToolOutputs(applyAgentToolPolicies(resolved as AgentToolSet | undefined) || {})
  const { materialize_sources: materializeSources, ...reportableTools } = tools
  return {
    ...withAgentToolStepReporting(reportableTools, reportToolStep as never),
    ...(materializeSources ? { materialize_sources: materializeSources } : {}),
  }
}

const defaultToolInputSchema = jsonSchema({
  additionalProperties: false,
  properties: {},
  type: "object",
})

function withDefaultToolInputSchemas<TTools extends Record<string, unknown> | undefined>(tools: TTools): TTools {
  if (!tools) return tools
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const record = tool as { inputSchema?: unknown, type?: unknown } | undefined
    if (!record || typeof record !== "object" || record.type === "provider" || record.type === "provider-defined" || record.inputSchema != null) {
      return [name, tool]
    }
    return [name, {
      ...record,
      inputSchema: defaultToolInputSchema,
    }]
  })) as TTools
}

function withRunCallbacks(settings: Record<string, unknown>, context: AgentAdapterRunContext) {
  const {
    onRunStepFinish,
    onRunToolCallFinish,
    onRunToolCallStart,
    onStepFinish,
    experimental_onToolCallFinish,
    experimental_onToolCallStart,
    ...rest
  } = settings as {
    experimental_onToolCallFinish?: (event: unknown) => MaybePromise<void>
    experimental_onToolCallStart?: (event: unknown) => MaybePromise<void>
    onRunStepFinish?: (step: unknown, context: unknown) => MaybePromise<void>
    onRunToolCallFinish?: (event: unknown, context: unknown) => MaybePromise<void>
    onRunToolCallStart?: (event: unknown, context: unknown) => MaybePromise<void>
    onStepFinish?: (step: unknown) => MaybePromise<void>
  } & Record<string, unknown>
  const callbackContext = {
    ...context.runtime,
    actor: context.actor,
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    run: context.runtime.run,
  }

  return {
    ...rest,
    ...(onRunStepFinish
      ? {
          async onStepFinish(step: unknown) {
            await onStepFinish?.(step)
            await onRunStepFinish(step, callbackContext)
          },
        }
      : onStepFinish ? { onStepFinish } : {}),
    ...(onRunToolCallStart
      ? {
          async experimental_onToolCallStart(event: unknown) {
            await experimental_onToolCallStart?.(event)
            await onRunToolCallStart(event, callbackContext)
          },
        }
      : experimental_onToolCallStart ? { experimental_onToolCallStart } : {}),
    ...(onRunToolCallFinish
      ? {
          async experimental_onToolCallFinish(event: unknown) {
            await experimental_onToolCallFinish?.(event)
            await onRunToolCallFinish(event, callbackContext)
          },
        }
      : experimental_onToolCallFinish ? { experimental_onToolCallFinish } : {}),
  }
}

function createUsageCapture() {
  let captured = false
  let capturedUsage: unknown

  const capture = (event: unknown) => {
    const record = typeof event === "object" && event !== null ? event as { totalUsage?: unknown, usage?: unknown } : undefined
    const usage = record?.totalUsage ?? record?.usage
    if (usage === undefined) return
    capturedUsage = usage
    captured = true
  }

  return {
    async onEnd(event: unknown) {
      capture(event)
    },
    async onStepEnd(event: unknown) {
      capture(event)
    },
    async onLanguageModelCallEnd(event: unknown) {
      capture(event)
    },
    get captured() {
      return captured
    },
    get usage() {
      return captured ? Promise.resolve(capturedUsage) : undefined
    },
  }
}

function withCapturedUsage(result: unknown, capture: ReturnType<typeof createUsageCapture>): unknown {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>
    const usage = record.usage
    const totalUsage = record.totalUsage
    Object.defineProperty(record, "usage", {
      configurable: true,
      enumerable: true,
      get() {
        return capture.usage ?? usage
      },
    })
    if (totalUsage !== undefined) {
      Object.defineProperty(record, "totalUsage", {
        configurable: true,
        enumerable: true,
        get() {
          return capture.usage ?? totalUsage
        },
      })
    }
    return result
  }

  if (!capture.captured) return result

  return {
    raw: result,
    text: typeof result === "string" ? result : undefined,
    usage: capture.usage,
  }
}

function readModelString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const item = record[key]
    if (typeof item === "string" && item) return item
  }
}

function withResolvedModelMetadata(result: unknown, model: unknown): unknown {
  const modelId = readModelString(model, "modelId", "model")
  const provider = readModelString(model, "provider", "providerId")
  if ((modelId === undefined && provider === undefined) || !result || typeof result !== "object") {
    return result
  }

  const record = result as Record<string, unknown>
  if (modelId !== undefined && record.modelId === undefined) {
    Object.defineProperty(record, "modelId", {
      configurable: true,
      enumerable: true,
      value: modelId,
    })
  }
  if (provider !== undefined && record.provider === undefined) {
    Object.defineProperty(record, "provider", {
      configurable: true,
      enumerable: true,
      value: provider,
    })
  }
  return result
}

function arrayFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

function withViteHubTelemetry(settings: Record<string, unknown>, context: AgentAdapterRunContext): Record<string, unknown> {
  if (!hasAgentTraceLog(context)) return settings
  const existing = (settings.telemetry || settings.experimental_telemetry || {}) as {
    integrations?: unknown
    isEnabled?: boolean
    recordInputs?: boolean
    recordOutputs?: boolean
  }
  const globalIntegrations = Array.isArray((globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS)
    ? (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS!
    : []
  const integrations = existing.integrations === undefined ? globalIntegrations : arrayFrom(existing.integrations)
  const telemetry = {
    ...existing,
    integrations: [...integrations, aiSdkTelemetryIntegration({
      context: context.context,
      input: context.input,
      invoker: context.invoker,
      run: context.runtime.run,
      runtime: context.runtime,
    })],
    isEnabled: existing.isEnabled ?? true,
    recordInputs: existing.recordInputs ?? false,
    recordOutputs: existing.recordOutputs ?? false,
  }

  return {
    ...settings,
    telemetry,
    experimental_telemetry: telemetry,
  }
}

async function createAgent(options: AiSdkAdapterOptions, context: AgentAdapterRunContext) {
  const { ToolLoopAgent, stepCountIs } = await import("ai")
  const execution = options.execution ?? options.modelExecution
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  const metadataContext = {
    ...runtime,
    actor: context.actor,
    context: context.context,
    fs: context.workspace?.fs,
    invoker: context.invoker,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const model = await resolveValue(options.model as never, metadataContext)
  const modelInstrumentation = execution?.instrumentation?.model
  const instrumentedModel = modelInstrumentation
    ? await modelInstrumentation({ ...runtime, actor: context.actor, context: context.context, invoker: context.invoker, model, run: context.runtime.run })
    : model
  const instructions = applyWorkspaceSourceInstructionSlot(
    applyCapabilityInstructionSlots(context.instructions ?? await resolveInstructions(options, metadataContext), context.capabilityInstructions),
    context.sourceInstructions,
  )
  const adapterTools = await resolveTools(options, metadataContext, context.devtools?.reportToolStep)
  const resolvedTools = withDefaultToolInputSchemas(await applyCapabilityToolTransforms({
    ...context.tools,
    ...adapterTools,
  }, []))
  const providerTools = Object.fromEntries((context.providerTools || []).map(tool => [tool.name, {
    args: tool.args || {},
    id: tool.id,
    name: tool.name,
    type: "provider-defined",
  }]))
  const toolSet = { ...resolvedTools, ...providerTools }
  const {
    instructions: _instructions,
    execution: _execution,
    modelExecution: _modelExecution,
    model: _model,
    tools: _tools,
  } = options
  const stepLimit = execution?.stepLimit
  const baseCallSettings = { ...(execution?.callSettings || {}) }
  const instrumentedCallSettings = await execution?.instrumentation?.callSettings?.({
    ...runtime,
    actor: context.actor,
    callSettings: { ...baseCallSettings },
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    model: instrumentedModel,
    run: context.runtime.run,
    ...(Object.keys(toolSet).length ? { tools: toolSet as AgentToolSet } : {}),
  })
  const settings = instrumentedCallSettings ? { ...baseCallSettings, ...instrumentedCallSettings } : baseCallSettings

  return {
    agent: new ToolLoopAgent({
      ...withRunCallbacks(withViteHubTelemetry(settings, context), context),
      instructions,
      model: instrumentedModel as never,
      stopWhen: ((settings as Record<string, unknown>).stopWhen ?? stepCountIs(stepLimit ?? 20)) as never,
      ...(Object.keys(toolSet).length ? { tools: toolSet as never } : {}),
    }),
    model: instrumentedModel,
    tools: Object.keys(toolSet).length ? toolSet : undefined,
  }
}

export function createAiSdkAdapter(options: AiSdkAdapterOptions): AgentAdapter {
  const staticTools = typeof options.tools === "object" && options.tools
    ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(options.tools as AgentToolSet) || {}))
    : undefined
  return {
    async generate(context) {
      const { agent, model, tools } = await createAgent(options, context)
      if (context.workspace && tools && "materialize_sources" in tools) {
        await reportWorkspaceMaterialization(tools as AgentToolSet, context.devtools?.reportToolStep)
      }
      const usageCapture = createUsageCapture()
      const callInput = getCallInput(context) as Record<string, unknown>
      const result = withResolvedModelMetadata(withCapturedUsage(await agent.generate({
        ...callInput,
        onEnd: usageCapture.onEnd,
        onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
        onStepEnd: usageCapture.onStepEnd,
      } as never) as GenerateTextResult<ToolSet, never, never>, usageCapture), model) as GenerateTextResult<ToolSet, never, never>
      const text = result.text.trim()
      const execution = options.execution ?? options.modelExecution
      const fallback = getFallbackOptions(execution?.workspaceFallback)
      if (fallback.enabled && (result.finishReason === "tool-calls" || !text && hasToolResults(result))) {
        const synthesized = await synthesizeWorkspaceFallback(model as never, context, result, fallback.maxToolResults)
        if (synthesized) return { raw: result, text: synthesized }
      }
      if (text) return result as unknown as AgentAdapterResult

      return result as unknown as AgentAdapterResult
    },
    async metadata(context) {
      const instructions = await resolveInstructions(options, context)
      const tools = options.tools ? await resolveValue(options.tools as never, context) : undefined
      const metadataTools = tools as AgentToolSet | undefined
      return {
        instructions: instructions ? [instructions] : [],
        tools: Object.entries(metadataTools || {}).map(([name, tool]) => ({
          category: "workspace",
          description: tool.description,
          icon: name === "shell" ? "i-lucide-terminal" : "i-lucide-wrench",
          name,
          preset: "vitehub-workspace",
          status: "available" as const,
        })),
      }
    },
    name: "ai-sdk",
    ...(staticTools ? { tools: staticTools } : {}),
    async stream(context) {
      const { agent, model } = await createAgent(options, context)
      const usageCapture = createUsageCapture()
      const execution = options.execution ?? options.modelExecution
      const fallback = getFallbackOptions(execution?.workspaceFallback)
      const fallbackCapture = fallback.enabled
        ? createWorkspaceFallbackEvidenceCapture(fallback.maxToolResults)
        : undefined
      const callInput = getCallInput(context) as Record<string, unknown>
      const result = withResolvedModelMetadata(withCapturedUsage(await agent.stream({
        ...callInput,
        onEnd: usageCapture.onEnd,
        onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
        async onStepEnd(event: unknown) {
          await usageCapture.onStepEnd(event)
          fallbackCapture?.collect(event)
        },
      } as never) as StreamTextResult<ToolSet, never, never>, usageCapture), model) as StreamTextResult<ToolSet, never, never>
      return withWorkspaceFallbackStreamResult(result, model as never, context, fallback, fallbackCapture?.evidence)
    },
  }
}

export function fromAiSdkAgent(agent: Agent): AgentAdapter {
  return {
    async generate(context) {
      return await agent.generate(getCallInput(context) as never)
    },
    name: "ai-sdk",
    async stream(context) {
      return await agent.stream(getCallInput(context) as never)
    },
  }
}
