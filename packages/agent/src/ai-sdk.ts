import { getMessageText, isAttachmentData, isAttachmentPart, resolveAttachmentData } from "./messages.ts"
import {
  cloneWithPropertyDescriptors,
  isAsyncIterable,
  teeingAsyncIterableStreamDescriptor,
} from "./internal/stream-result.ts"
import { loadAiSdk } from "./internal/ai-sdk-runtime.ts"
import { markMessageChannelInstructionConsumer, resolveMessageChannelInstructions } from "./internal/channels.ts"
import {
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import { agentInvocationCallbackContextValues } from "./invocation-context.ts"
import { composeInstructionDocument } from "./instruction-composition.ts"
import { agentOutputInstructions, agentOutputJsonSchema } from "./internal/agent-structured-output.ts"
import { synthesizedAgentOutputSymbol } from "./internal/synthesized-agent-output.ts"
import { getModelCallSettings } from "./internal/model-call-settings.ts"
import { materializeAgentModel } from "./internal/agent-model.ts"
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
  UserContent,
} from "ai"
import type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentCallSettingsInstrumentationContext,
  AgentAttachmentExecutionOptions,
  AgentModelExecutionInstrumentation,
  AgentModelExecutionOptions,
  AgentModelResolver,
  AgentModelResolverContext,
  AgentModelInstrumentationContext,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentToolResolverWithWorkspace,
  MaybePromise,
} from "./types.ts"
import type { AttachmentData, AttachmentPart, Message, MessagePart } from "./messages.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { JSONSchema7 } from "json-schema"

export interface AiSdkAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
  Name extends WorkspaceName = WorkspaceName,
> {
  execution?: AiSdkModelExecutionOptions<TRuntimeConfig, TCallOptions, TTools>
  instructions?: AgentAdapterInstructions<TRuntimeConfig, Name>
  model: AgentModelResolver<TRuntimeConfig, Name>
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
> = Omit<AgentModelExecutionOptions<TRuntimeConfig, TCallOptions>, "attachments" | "callSettings" | "workspaceFallback"> & {
  attachments?: AiSdkAttachmentOptions
  callSettings?: AiSdkModelCallSettings<TCallOptions, TTools>
  workspaceFallback?: boolean | AiSdkWorkspaceFallbackOptions
}

export type AiSdkAttachmentOptions = AgentAttachmentExecutionOptions

export interface AiSdkWorkspaceFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

function isDataMessagePart(part: MessagePart): part is Extract<MessagePart, { type: "data" | `data-${string}` }> {
  return part.type === "data" || part.type.startsWith("data-")
}

type UserContentPart = Exclude<UserContent, string>[number]

function attachmentModelData(part: AttachmentPart): Exclude<AttachmentData, Blob> | URL | undefined {
  if (part.data && !(part.data instanceof Blob)) return part.data
  if (part.url) {
    try {
      const url = new URL(part.url)
      if (url.protocol === "https:") return url
    }
    catch {
      // Invalid URLs are not model input.
    }
  }
  if (part.data instanceof Blob) {
    throw new TypeError("[vitehub] toAiSdkModelMessages() cannot convert a Blob synchronously. Pass the message through a model-backed Agent Driver or provide an HTTPS URL.")
  }
  if (part.fetchData) {
    throw new TypeError("[vitehub] toAiSdkModelMessages() cannot resolve attachment callbacks synchronously. Pass the message through a model-backed Agent Driver or provide an HTTPS URL.")
  }
}

function toAttachmentModelPart(part: AttachmentPart): UserContentPart | undefined {
  const data = attachmentModelData(part)
  if (!data) return
  if (part.type === "image") {
    return { image: data, mediaType: part.mediaType, type: "image" }
  }
  return {
    data,
    filename: part.name,
    mediaType: part.mediaType,
    type: "file",
  }
}

function toUserModelMessageContent(parts: MessagePart[]): UserContent | undefined {
  const attachments = parts.flatMap(part => isAttachmentPart(part) ? [toAttachmentModelPart(part)] : []).filter((part): part is UserContentPart => !!part)
  if (!attachments.length) {
    const text = toTextModelMessageContent(parts)
    return text || undefined
  }
  const content: UserContentPart[] = []
  for (const part of parts) {
    if (isAttachmentPart(part)) {
      const attachment = toAttachmentModelPart(part)
      if (attachment) content.push(attachment)
      continue
    }
    const text = toTextModelMessageContent([part])
    if (text) content.push({ text, type: "text" })
  }
  return content.length ? content : undefined
}

function toTextModelMessageContent(parts: MessagePart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "error") return part.error
    if (isDataMessagePart(part)) return JSON.stringify(part.data)
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
      toolCallId: part.toolCallId ?? part.id,
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
      const content = message.role === "user"
        ? toUserModelMessageContent(message.parts)
        : getMessageText(message) || toTextModelMessageContent(message.parts)
      return hasModelMessageContent(content)
        ? [{ content, role: message.role } as ModelMessage]
        : []
    })
}

function hasModelMessageContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  return Array.isArray(content) ? content.length > 0 : content != null
}

const defaultAiSdkAttachmentMaxBytes = 25 * 1024 * 1024

function aiSdkAttachmentMaxBytes(options: AiSdkAttachmentOptions | undefined): number {
  const maxBytes = options?.maxBytes ?? defaultAiSdkAttachmentMaxBytes
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("[vitehub] aiSdk({ execution: { attachments: { maxBytes } } }) must be a positive finite number.")
  }
  return maxBytes
}

function attachmentDataByteLength(data: AttachmentData | undefined): number | undefined {
  if (data instanceof Blob) return data.size
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength
}

function resolvedImageMediaType(data: AttachmentData): string | undefined {
  if (data instanceof Blob && data.type.startsWith("image/")) return data.type
  if (typeof data === "string") {
    const dataUrlMediaType = /^data:(image\/[^;,]+)[;,]/i.exec(data)?.[1]?.toLowerCase()
    if (dataUrlMediaType) return dataUrlMediaType
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return
    try {
      const decoded = atob(data.slice(0, Math.min(data.length, 24)))
      return resolvedImageMediaType(Uint8Array.from(decoded, character => character.charCodeAt(0)))
    }
    catch {
      return
    }
  }
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : data instanceof Uint8Array ? data : undefined
  if (!bytes) return
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte)
  if (startsWith([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return "image/png"
  if (startsWith([0xFF, 0xD8, 0xFF])) return "image/jpeg"
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif"
  if (startsWith([0x42, 0x4D])) return "image/bmp"
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  if (startsWith([0x49, 0x49, 0x2A, 0x00]) || startsWith([0x4D, 0x4D, 0x00, 0x2A])) return "image/tiff"
  if (startsWith([0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
}

function assertAttachmentWithinLimit(part: AttachmentPart, byteLength: number | undefined, maxBytes: number): void {
  if (typeof byteLength === "number" && byteLength > maxBytes) {
    throw new Error(`[vitehub] ${part.type} attachment is ${byteLength} bytes, which exceeds maxBytes (${maxBytes}).`)
  }
}

async function resolveModelAttachmentPart(part: AttachmentPart, maxBytes: number): Promise<{ byteLength: number, part: AttachmentPart }> {
  assertAttachmentWithinLimit(part, part.size, maxBytes)
  const resolved = await resolveAttachmentData(part)
  if (typeof part.fetchData === "function" && !isAttachmentData(resolved)) {
    throw new TypeError(`[vitehub] ${part.type} attachment fetchData() did not return supported attachment data.`)
  }
  if (!resolved) return { byteLength: part.size ?? 0, part }
  const byteLength = attachmentDataByteLength(resolved) ?? 0
  assertAttachmentWithinLimit(part, byteLength, maxBytes)
  const data = resolved instanceof Blob ? await resolved.arrayBuffer() : resolved
  const { fetchData: _fetchData, ...rest } = part
  const mediaType = part.type === "image"
    ? resolvedImageMediaType(resolved) ?? resolvedImageMediaType(data)
    : undefined
  return { byteLength, part: { ...rest, data, ...(mediaType ? { mediaType } : {}) } }
}

function channelCurrentMessageId(context: AgentAdapterRunContext): string | null | undefined {
  const inputContext = context.input.context
  if (!inputContext || typeof inputContext !== "object") return
  const channel = "channel" in inputContext && inputContext.channel && typeof inputContext.channel === "object"
    ? inputContext.channel as Record<string, unknown>
    : undefined
  const message = channel?.message && typeof channel.message === "object"
    ? channel.message as Record<string, unknown>
    : undefined
  return typeof message?.id === "string" && message.id ? message.id : null
}

async function resolveModelAttachments(messages: Message[], options: AiSdkAttachmentOptions | undefined, currentMessageId?: string | null): Promise<Message[]> {
  const maxBytes = aiSdkAttachmentMaxBytes(options)
  let remainingBytes = maxBytes
  const resolvedMessages: Message[] = []
  const currentMessageIndex = currentMessageId === null
    ? messages.findLastIndex(message => message.role === "user")
    : undefined
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "user") {
      resolvedMessages.push(message)
      continue
    }
    const parts: MessagePart[] = []
    for (const part of message.parts) {
      if (!isAttachmentPart(part)) {
        parts.push(part)
        continue
      }
      const isHistoricalChannelMessage = currentMessageId !== undefined
        && (currentMessageId === null ? messageIndex !== currentMessageIndex : message.id !== currentMessageId)
      if (isHistoricalChannelMessage) {
        const { fetchData: _fetchData, ...reference } = part
        if (reference.data || reference.url) {
          const resolved = await resolveModelAttachmentPart(reference, remainingBytes)
          remainingBytes -= resolved.byteLength
          parts.push(resolved.part)
        }
        continue
      }
      const resolved = await resolveModelAttachmentPart(part, remainingBytes)
      remainingBytes -= resolved.byteLength
      parts.push(resolved.part)
    }
    resolvedMessages.push({ ...message, parts })
  }
  return resolvedMessages
}

async function getCallInput(context: AgentAdapterRunContext, attachments?: AiSdkAttachmentOptions) {
  const base = {
    abortSignal: context.input.abortSignal,
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
    return {
      ...base,
      messages: toAiSdkModelMessages(await resolveModelAttachments(context.messages, attachments, channelCurrentMessageId(context))),
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

  const { generateText } = await loadAiSdk()
  const summary = await generateText({
    instructions: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
      resolveMessageChannelInstructions(context.context, context),
    ].filter(Boolean).join("\n"),
    model,
    prompt: [
      `User message:\n${getPromptText(context)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

function createWorkspaceFallbackEvidenceCapture(maxToolResults: number) {
  const evidence: string[] = []
  const seen = new Set<string>()

  return {
    collect(event: unknown) {
      for (const output of collectToolResultOutputs(event)) {
        if (evidence.length >= maxToolResults) break
        const text = JSON.stringify(output).slice(0, 4000)
        if (seen.has(text)) continue
        seen.add(text)
        evidence.push(text)
      }
    },
    evidence() {
      return evidence.slice()
    },
  }
}

function withWorkspaceFallbackToolEvidence<TTools extends AgentToolSet | undefined>(
  tools: TTools,
  capture?: ReturnType<typeof createWorkspaceFallbackEvidenceCapture>,
): TTools {
  if (!capture || !tools || typeof tools !== "object") return tools

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    return [name, {
      ...tool,
      async execute(input: unknown, ...args: unknown[]) {
        try {
          const output = await execute.call(tool, input, ...args)
          capture.collect({ output, toolName: name, type: "tool-result" })
          return output
        }
        catch (error) {
          capture.collect({ error: error instanceof Error ? error.message : String(error), toolName: name, type: "tool-error" })
          throw error
        }
      },
    }]
  })) as TTools
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
  return [{ id: "workspace-fallback", text, type: "text-delta" }]
}

function cloneStreamTextResult<T extends object>(result: T, streams: { fullStream?: AsyncIterable<unknown>, stream?: AsyncIterable<unknown> }): T {
  return cloneWithPropertyDescriptors(result, Object.fromEntries(Object.entries(streams).map(([key, stream]) => [
    key,
    teeingAsyncIterableStreamDescriptor(stream),
  ])))
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
    const hasFinalText = evidence.length ? textAfterLastToolResult.trim() : text.trim()
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

function withWorkspaceFallbackStreamResult<T extends { fullStream?: AsyncIterable<unknown>, stream?: AsyncIterable<unknown> }>(
  result: T,
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  fallback: Required<AiSdkWorkspaceFallbackOptions>,
  capturedEvidence?: () => string[],
): T {
  if (!fallback.enabled) return result
  const stream = result.stream
  const fullStream = result.fullStream
  if (stream || fullStream) {
    const wrappedStream = stream
      ? withWorkspaceFallbackFullStream(stream, model, context, fallback.maxToolResults, capturedEvidence)
      : undefined
    const wrappedFullStream = fullStream
      ? fullStream === stream && wrappedStream
        ? wrappedStream
        : withWorkspaceFallbackFullStream(fullStream, model, context, fallback.maxToolResults, capturedEvidence)
      : undefined
    return cloneStreamTextResult(result as object, {
      ...(wrappedStream ? { stream: wrappedStream } : {}),
      ...(wrappedFullStream ? { fullStream: wrappedFullStream } : {}),
    }) as T
  }
  if (isAsyncIterable(result)) {
    return withWorkspaceFallbackFullStream(result, model, context, fallback.maxToolResults, capturedEvidence) as unknown as T
  }
  return result
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

async function composeInstructions(
  instructions: string,
  context: AgentAdapterMetadataContext,
  workspace?: Record<string, unknown>,
) {
  return await composeInstructionDocument(instructions, { context: context.context.toJSON(), workspace })
}

async function resolveTools(options: AiSdkAdapterOptions, context: AgentAdapterMetadataContext, reportToolStep?: AgentAdapterRunContext["toolStepReporter"]) {
  if (!options.tools) return undefined
  const resolved = await resolveValue(options.tools as never, context)
  const tools = withJsonCompatibleToolOutputs(applyAgentToolPolicies(resolved as AgentToolSet | undefined) || {})
  const { materialize_sources: materializeSources, ...reportableTools } = tools
  return {
    ...withAgentToolStepReporting(reportableTools, reportToolStep as never),
    ...(materializeSources ? { materialize_sources: materializeSources } : {}),
  }
}

const defaultToolInputSchemaJson = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const

function withDefaultToolInputSchemas<TTools extends Record<string, unknown> | undefined>(tools: TTools, createJsonSchema: (schema: JSONSchema7) => unknown): TTools {
  if (!tools) return tools
  let defaultToolInputSchema: unknown
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const record = tool as { inputSchema?: unknown, type?: unknown } | undefined
    if (!record || typeof record !== "object" || record.type === "provider" || record.type === "provider-defined") {
      return [name, tool]
    }
    if (record.inputSchema != null) {
      const inputSchema = record.inputSchema
      if (typeof inputSchema !== "object" || inputSchema === null || "~standard" in inputSchema || "jsonSchema" in inputSchema) {
        return [name, tool]
      }
      return [name, {
        ...record,
        inputSchema: createJsonSchema(inputSchema as JSONSchema7),
      }]
    }
    defaultToolInputSchema ??= createJsonSchema(defaultToolInputSchemaJson)
    return [name, {
      ...record,
      inputSchema: defaultToolInputSchema,
    }]
  })) as TTools
}

function createAiSdkRuntimeContext(context: AgentAdapterRunContext) {
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  return {
    ...runtime,
    actor: context.actor,
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    run: context.runtime.run,
  }
}

function withRuntimeContext(settings: Record<string, unknown>, context: AgentAdapterRunContext): Record<string, unknown> {
  const runtimeContext = createAiSdkRuntimeContext(context)
  const existing = settings.runtimeContext
  const {
    onRunStepFinish: _onRunStepFinish,
    onRunToolCallFinish: _onRunToolCallFinish,
    onRunToolCallStart: _onRunToolCallStart,
    ...rest
  } = settings
  return {
    ...rest,
    runtimeContext: existing && typeof existing === "object"
      ? { ...runtimeContext, ...(existing as Record<string, unknown>) }
      : runtimeContext,
  }
}

function createUsageCapture() {
  let captured = false
  let capturedUsage: unknown

  const capture = (event: unknown) => {
    const record = typeof event === "object" && event !== null ? event as { totalUsage?: unknown, usage?: unknown } : undefined
    const usage = record?.usage ?? record?.totalUsage
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
  }
}

function modelExecutionInstrumentation(
  options: AiSdkAdapterOptions,
  context: AgentAdapterRunContext,
): AgentModelExecutionInstrumentation[] {
  const instrumentation = options.execution?.instrumentation
  return [
    ...(instrumentation ? [instrumentation as AgentModelExecutionInstrumentation] : []),
    ...(context.modelExecutionInstrumentation || []),
  ]
}

async function instrumentModel(
  model: unknown,
  instrumentations: AgentModelExecutionInstrumentation[],
  context: AgentModelInstrumentationContext,
) {
  let current = model
  for (const instrumentation of instrumentations) {
    current = await instrumentation.model?.({ ...context, model: current }) ?? current
  }
  return current
}

async function instrumentCallSettings(
  callSettings: Record<string, unknown>,
  instrumentations: AgentModelExecutionInstrumentation[],
  context: Omit<AgentCallSettingsInstrumentationContext, "callSettings">,
) {
  let current = callSettings
  let patch: Record<string, unknown> | undefined
  for (const instrumentation of instrumentations) {
    const next = await instrumentation.callSettings?.({ ...context, callSettings: { ...current } })
    if (!next) continue
    patch = { ...patch, ...next }
    current = { ...current, ...next }
  }
  return patch
}

function mergeCallSettings(
  defaults: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const settings = { ...defaults, ...overrides }
  const defaultProviders = defaults?.providerOptions
  const overrideProviders = overrides?.providerOptions
  if ((!defaultProviders || typeof defaultProviders !== "object")
    && (!overrideProviders || typeof overrideProviders !== "object")) return settings
  const providers = {
    ...(defaultProviders as Record<string, unknown> | undefined),
    ...(overrideProviders as Record<string, unknown> | undefined),
  }
  for (const provider of new Set([
    ...Object.keys((defaultProviders as Record<string, unknown> | undefined) || {}),
    ...Object.keys((overrideProviders as Record<string, unknown> | undefined) || {}),
  ])) {
    const defaultSettings = (defaultProviders as Record<string, unknown> | undefined)?.[provider]
    const overrideSettings = (overrideProviders as Record<string, unknown> | undefined)?.[provider]
    if ((defaultSettings && typeof defaultSettings === "object")
      || (overrideSettings && typeof overrideSettings === "object")) {
      providers[provider] = {
        ...(defaultSettings as Record<string, unknown> | undefined),
        ...(overrideSettings as Record<string, unknown> | undefined),
      }
    }
  }
  settings.providerOptions = providers
  return settings
}

async function createAgent(
  options: AiSdkAdapterOptions,
  context: AgentAdapterRunContext,
  fallbackCapture?: ReturnType<typeof createWorkspaceFallbackEvidenceCapture>,
) {
  const aiSdk = await loadAiSdk()
  const { ToolLoopAgent, isStepCount, jsonSchema } = aiSdk
  const execution = options.execution
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  const metadataContext = {
    ...agentInvocationCallbackContextValues(context.context),
    ...runtime,
    actor: context.actor,
    context: context.context,
    fs: context.workspace?.fs,
    invoker: context.invoker,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const modelContext = {
    ...metadataContext,
    runtimeConfig: context.runtime.runtimeConfig,
  } as AgentModelResolverContext
  const model = await materializeAgentModel(await resolveValue(options.model as never, modelContext), modelContext)
  const instrumentations = modelExecutionInstrumentation(options, context)
  const instrumentedModel = instrumentations.length
    ? await instrumentModel(model, instrumentations, { ...runtime, actor: context.actor, context: context.context, invoker: context.invoker, model, run: context.runtime.run })
    : model
  const instructions = await composeInstructions(
    joinInstructions(
      await resolveInstructions(options, metadataContext),
      context.instructions,
      resolveMessageChannelInstructions(context.context, context),
      agentOutputInstructions(context.output),
    ),
    metadataContext,
    context.workspaceInstructionBindings,
  )
  const adapterTools = await resolveTools(options, metadataContext, context.toolStepReporter)
  const resolvedTools = withDefaultToolInputSchemas(withWorkspaceFallbackToolEvidence(await applyCapabilityToolTransforms({
    ...context.tools,
    ...adapterTools,
  }, []), fallbackCapture), jsonSchema)
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
    model: _model,
    tools: _tools,
  } = options
  const stepLimit = execution?.stepLimit
  const baseCallSettings = mergeCallSettings(getModelCallSettings(model), execution?.callSettings)
  const instrumentedCallSettings = await instrumentCallSettings(baseCallSettings, instrumentations, {
    ...runtime,
    actor: context.actor,
    context: context.context,
    input: context.input,
    invoker: context.invoker,
    model: instrumentedModel,
    run: context.runtime.run,
    ...(Object.keys(toolSet).length ? { tools: toolSet as AgentToolSet } : {}),
  })
  const settings = instrumentedCallSettings ? { ...baseCallSettings, ...instrumentedCallSettings } : baseCallSettings
  const outputSchema = context.output ? agentOutputJsonSchema(context.output.schema) : undefined

  return {
    agent: new ToolLoopAgent({
      ...withRuntimeContext(withViteHubTelemetry(settings, context), context),
      instructions,
      model: instrumentedModel as never,
      ...(outputSchema
        ? { output: aiSdk.Output.object({ schema: jsonSchema(outputSchema) }) }
        : {}),
      stopWhen: ((settings as Record<string, unknown>).stopWhen ?? isStepCount(stepLimit ?? 20)) as never,
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
  return markMessageChannelInstructionConsumer({
    async generate(context) {
      const execution = options.execution
      const callInput = await getCallInput(context, execution?.attachments) as Record<string, unknown>
      const fallback = getFallbackOptions(execution?.workspaceFallback)
      const fallbackCapture = fallback.enabled
        ? createWorkspaceFallbackEvidenceCapture(fallback.maxToolResults)
        : undefined
      const { agent, model, tools } = await createAgent(options, context, fallbackCapture)
      if (context.workspace && tools && "materialize_sources" in tools) {
        await reportWorkspaceMaterialization(tools as AgentToolSet, context.toolStepReporter)
      }
      const usageCapture = createUsageCapture()
      const result = withResolvedModelMetadata(withCapturedUsage(await agent.generate({
        ...callInput,
        onEnd: usageCapture.onEnd,
        onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
        onStepEnd: usageCapture.onStepEnd,
      } as never) as GenerateTextResult<ToolSet, never, never>, usageCapture), model) as GenerateTextResult<ToolSet, never, never>
      const text = result.text.trim()
      if (fallback.enabled && (result.finishReason === "tool-calls" || !text && hasToolResults(result))) {
        const synthesized = await synthesizeWorkspaceFallback(model as never, context, result, fallback.maxToolResults)
          ?? await synthesizeWorkspaceFallbackFromEvidence(model as never, context, fallbackCapture?.evidence() ?? [])
        if (synthesized) {
          const output = { raw: result, text: synthesized }
          Object.defineProperty(output, synthesizedAgentOutputSymbol, { value: true })
          return output
        }
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
      const usageCapture = createUsageCapture()
      const execution = options.execution
      const fallback = getFallbackOptions(execution?.workspaceFallback)
      const fallbackCapture = fallback.enabled
        ? createWorkspaceFallbackEvidenceCapture(fallback.maxToolResults)
        : undefined
      const { agent, model } = await createAgent(options, context, fallbackCapture)
      const captureStep = async (event: unknown) => {
        await usageCapture.onStepEnd(event)
        fallbackCapture?.collect(event)
      }
      const callInput = await getCallInput(context, execution?.attachments) as Record<string, unknown>
      const result = withResolvedModelMetadata(withCapturedUsage(await agent.stream({
        ...callInput,
        onEnd: usageCapture.onEnd,
        onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
        onStepEnd: captureStep,
      } as never) as StreamTextResult<ToolSet, never, never>, usageCapture), model) as StreamTextResult<ToolSet, never, never>
      return withWorkspaceFallbackStreamResult(result, model as never, context, fallback, fallbackCapture?.evidence)
    },
  })
}

export function fromAiSdkAgent(agent: Agent): AgentAdapter {
  return {
    async generate(context) {
      return await agent.generate(await getCallInput(context) as never)
    },
    name: "ai-sdk",
    async stream(context) {
      return await agent.stream(await getCallInput(context) as never)
    },
  }
}
