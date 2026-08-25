import { asUnknownBoundary, hasRuntimeType } from "./internal/runtime-type.ts"
import { getMessageText, isAttachmentData, isAttachmentPart, resolveAttachmentData } from "./messages.ts"
import {
  cloneWithPropertyDescriptors,
  isAsyncIterable,
  teeingAsyncIterableStreamDescriptor,
  toReadableAsyncIterableStream,
} from "./internal/stream-result.ts"
import { loadAiSdk } from "./internal/ai-sdk-runtime.ts"
import { markMessageChannelInstructionConsumer, resolveMessageChannelInstructions } from "./internal/channels.ts"
import {
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import { agentInvocationCallbackContextValues } from "./invocation-context.ts"
import { composeInstructionDocument } from "./instruction-composition.ts"
import { agentOutputInstructions, agentOutputJsonSchema, agentOutputRepairSymbol, nativeAgentOutputValidationFailure, normalizeNativeAgentOutputError, validateAgentOutput } from "./internal/agent-structured-output.ts"
import { synthesizedAgentOutputSymbol } from "./internal/synthesized-agent-output.ts"
import { resolveAgentUsageRecord } from "./agent-output.ts"
import { aggregateAgentUsageCosts } from "./internal/usage-pricing.ts"
import { getModelCallSettings } from "./internal/model-call-settings.ts"
import { materializeAgentModel } from "./internal/agent-model.ts"
import { updateAgentTelemetryConfiguration } from "./internal/agent-telemetry.ts"
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
  ToolCallRepairFunction,
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
  AgentUsageRecord,
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
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return { type: "error-text", value: part.error } as ToolResultPart["output"]
  }
  const output = part.output ?? null
  if (hasRuntimeType(output, "string")) {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return { type: "text", value: output } as ToolResultPart["output"]
  }
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return { text: part.text, type: "text" as const }
  }
  if (isDataMessagePart(part) && (part.type.startsWith("data-chat-reply-") || part.type === "data-chat-user-message-context")) {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return { text: JSON.stringify(part.data), type: "text" as const }
  }
  if (part.type === "tool-call") {
    return {
      input: part.input ?? {},
      toolCallId: part.id,
      toolName: part.name,
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      type: "tool-call" as const,
    }
  }
  if (part.type === "approval-request") {
    return {
      approvalId: part.id,
      toolCallId: part.toolCallId ?? part.id,
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          ? [{ content, role: message.role } as ModelMessage]
          : []
      }
      const content = message.role === "user"
        ? toUserModelMessageContent(message.parts)
        : getMessageText(message) || toTextModelMessageContent(message.parts)
      return hasModelMessageContent(content)
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        ? [{ content, role: message.role } as ModelMessage]
        : []
    })
}

function hasModelMessageContent(content: unknown): boolean {
  if (hasRuntimeType(content, "string")) return content.trim().length > 0
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
  if (hasRuntimeType(data, "string")) return new TextEncoder().encode(data).byteLength
}

function resolvedImageMediaType(data: AttachmentData): string | undefined {
  if (data instanceof Blob && data.type.startsWith("image/")) return data.type
  if (hasRuntimeType(data, "string")) {
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
  if (hasRuntimeType(byteLength, "number") && byteLength > maxBytes) {
    throw new Error(`[vitehub] ${part.type} attachment is ${byteLength} bytes, which exceeds maxBytes (${maxBytes}).`)
  }
}

async function resolveModelAttachmentPart(part: AttachmentPart, maxBytes: number): Promise<{ byteLength: number, part: AttachmentPart }> {
  assertAttachmentWithinLimit(part, part.size, maxBytes)
  const resolved = await resolveAttachmentData(part)
  if (hasRuntimeType(part.fetchData, "function") && !isAttachmentData(resolved)) {
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
  if (!inputContext || !hasRuntimeType(inputContext, "object")) return
  const channel = "channel" in inputContext && inputContext.channel && hasRuntimeType(inputContext.channel, "object")
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ? inputContext.channel as Record<string, unknown>
    : undefined
  const message = channel?.message && hasRuntimeType(channel.message, "object")
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ? channel.message as Record<string, unknown>
    : undefined
  return hasRuntimeType(message?.id, "string") && message.id ? message.id : null
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
  usageCapture?: ReturnType<typeof createUsageCapture>,
) {
  const evidence = collectToolResults(result, maxToolResults)
  return await synthesizeWorkspaceFallbackFromEvidence(model, context, evidence, usageCapture)
}

async function synthesizeWorkspaceFallbackFromEvidence(
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  evidence: string[],
  usageCapture?: ReturnType<typeof createUsageCapture>,
) {
  if (evidence.length === 0) return undefined

  const { generateText } = await loadAiSdk()
  const summary = await generateText({
    instructions: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
      agentOutputInstructions(context.output),
      resolveMessageChannelInstructions(context.context, context),
    ].filter(Boolean).join("\n"),
    model,
    ...(usageCapture
      ? {
          onEnd: usageCapture.onEnd,
          onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
          onStepEnd: usageCapture.onStepEnd,
        }
      : {}),
    prompt: [
      `User message:\n${getPromptText(context)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  const text = summary.text.trim()
  return text ? { result: summary, text } : undefined
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
  if (!capture || !tools || !hasRuntimeType(tools, "object")) return tools

  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    if (!tool || !hasRuntimeType(tool, "object") || !hasRuntimeType((tool as { execute?: unknown }).execute, "function")) {
      return [name, tool]
    }

    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
  if (hasRuntimeType(event, "string")) return event
  if (!hasRuntimeType(event, "object") || event === null) return undefined
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const record = event as { delta?: unknown, text?: unknown, textDelta?: unknown, type?: unknown }
  if (record.type !== "text-delta" && record.type !== "text") return undefined
  const text = record.text ?? record.textDelta ?? record.delta
  return hasRuntimeType(text, "string") ? text : undefined
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  return hasRuntimeType(value, "object") && value !== null ? value as Record<string, unknown> : undefined
}

function pushDefinedOutput(outputs: unknown[], output: unknown): void {
  if (output !== undefined) outputs.push(output)
}

function collectToolResultOutputs(value: unknown): unknown[] {
  const record = recordFrom(value)
  if (!record) return []
  const type = hasRuntimeType(record.type, "string") ? record.type : undefined
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
  if (!hasRuntimeType(event, "object") || event === null) return []
  return collectToolResultOutputs(event)
}

function streamEventType(event: unknown): string | undefined {
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  return hasRuntimeType(event, "object") && event !== null && hasRuntimeType((event as { type?: unknown }).type, "string")
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ? (event as { type: string }).type
    : undefined
}

function workspaceFallbackFinishEvent(finishEvent: unknown): unknown {
  return hasRuntimeType(finishEvent, "object") && finishEvent !== null
    ? { ...finishEvent, finishReason: "workspace-fallback", type: "finish" }
    : { finishReason: "workspace-fallback", type: "finish" }
}

function finishEventReason(event: unknown): string | undefined {
  if (!hasRuntimeType(event, "object") || event === null) return undefined
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const record = event as { finishReason?: unknown, reason?: unknown }
  const reason = record.finishReason ?? record.reason
  return hasRuntimeType(reason, "string") ? reason : undefined
}

function workspaceFallbackTextEvents(text: string): unknown[] {
  return [{ id: "workspace-fallback", text, type: "text-delta" }]
}

function cloneStreamTextResult<T extends object>(
  result: T,
  streams: {
    fullStream?: AsyncIterable<unknown>
    stream?: AsyncIterable<unknown>
    toUIMessageStream?: (...args: unknown[]) => ReadableStream<unknown>
  },
  teeStreams = true,
): T {
  const overrides: PropertyDescriptorMap = {}
  if (streams.stream) {
    overrides.stream = teeStreams
      ? teeingAsyncIterableStreamDescriptor(streams.stream)
      : { configurable: true, enumerable: true, value: toReadableAsyncIterableStream(streams.stream, { highWaterMark: 0 }), writable: true }
  }
  if (streams.fullStream) {
    overrides.fullStream = teeStreams
      ? teeingAsyncIterableStreamDescriptor(streams.fullStream)
      : { configurable: true, enumerable: true, value: toReadableAsyncIterableStream(streams.fullStream, { highWaterMark: 0 }), writable: true }
  }
  if (streams.toUIMessageStream) {
    overrides.toUIMessageStream = {
      configurable: true,
      enumerable: true,
      value: streams.toUIMessageStream,
      writable: true,
    }
  }
  return cloneWithPropertyDescriptors(result, overrides)
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
      yield* workspaceFallbackTextEvents(synthesized.text)
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
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return cloneStreamTextResult(result as object, {
      ...(wrappedStream ? { stream: wrappedStream } : {}),
      ...(wrappedFullStream ? { fullStream: wrappedFullStream } : {}),
    }, false) as T
  }
  if (isAsyncIterable(result)) {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    return asUnknownBoundary(withWorkspaceFallbackFullStream(result, model, context, fallback.maxToolResults, capturedEvidence)) as T
  }
  return result
}

async function resolveValue<T>(value: T | ((context: AgentAdapterMetadataContext) => MaybePromise<T>), context: AgentAdapterMetadataContext): Promise<T> {
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  return hasRuntimeType(value, "function") ? await (value as (context: AgentAdapterMetadataContext) => MaybePromise<T>)(context) : value
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
  const instructions = await Promise.all(parts.map(part => hasRuntimeType(part, "function")
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
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const resolved = await resolveValue(options.tools as never, context)
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const tools = withJsonCompatibleToolOutputs(applyAgentToolPolicies(resolved as AgentToolSet | undefined) || {})
  const { materialize_sources: materializeSources, ...reportableTools } = tools
  return {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...withAgentToolStepReporting(reportableTools, reportToolStep as never),
    ...(materializeSources ? { materialize_sources: materializeSources } : {}),
  }
}

// SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
const defaultToolInputSchemaJson = {
  additionalProperties: false,
  properties: {},
  type: "object",
} as const

function withDefaultToolInputSchemas<TTools extends Record<string, unknown> | undefined>(tools: TTools, createJsonSchema: (schema: JSONSchema7) => unknown): TTools {
  if (!tools) return tools
  let defaultToolInputSchema: unknown
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const record = tool as { inputSchema?: unknown, type?: unknown } | undefined
    if (!record || !hasRuntimeType(record, "object") || record.type === "provider" || record.type === "provider-defined") {
      return [name, tool]
    }
    if (record.inputSchema != null) {
      const inputSchema = record.inputSchema
      if (!hasRuntimeType(inputSchema, "object") || inputSchema === null || "~standard" in inputSchema || "jsonSchema" in inputSchema) {
        return [name, tool]
      }
      return [name, {
        ...record,
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
    runtimeContext: existing && hasRuntimeType(existing, "object")
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      ? { ...runtimeContext, ...(existing as Record<string, unknown>) }
      : runtimeContext,
  }
}

function createUsageCapture() {
  let captured = false
  let capturedUsage: unknown
  let metadataSource: unknown
  let start!: () => void
  let publish!: () => void
  let complete!: () => void
  const started = new Promise<void>((resolve) => { start = resolve })
  const published = new Promise<void>((resolve) => { publish = resolve })
  const completed = new Promise<void>((resolve) => { complete = resolve })

  const capture = (event: unknown) => {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const record = hasRuntimeType(event, "object") && event !== null ? event as { totalUsage?: unknown, usage?: unknown } : undefined
    const usage = record?.usage ?? record?.totalUsage
    if (usage === undefined) return
    capturedUsage = usage
    metadataSource = event
    captured = true
    publish()
  }

  return {
    capture,
    complete,
    completed,
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
    start,
    started,
    published,
    get usage() {
      return captured ? Promise.resolve(capturedUsage) : undefined
    },
    get usageSource() {
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      return captured ? { ...(metadataSource as Record<string, unknown>), usage: capturedUsage } : undefined
    },
  }
}

async function combinedCapturedUsage(captures: readonly ReturnType<typeof createUsageCapture>[]): Promise<unknown> {
  const usages = await Promise.all(captures.flatMap(capture => capture.usage ? [capture.usage] : []))
  if (usages.length < 2) return usages[0]
  const add = (left: unknown, right: unknown): unknown => {
    if (hasRuntimeType(left, "number") || hasRuntimeType(right, "number")) {
      return (hasRuntimeType(left, "number") ? left : 0) + (hasRuntimeType(right, "number") ? right : 0)
    }
    if (!left || !hasRuntimeType(left, "object")) return right
    if (!right || !hasRuntimeType(right, "object")) return left
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const leftRecord = left as Record<string, unknown>
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const rightRecord = right as Record<string, unknown>
    return Object.fromEntries([...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
      .map(key => [key, add(leftRecord[key], rightRecord[key])]))
  }
  return usages.reduce(add)
}

function withCapturedUsage(
  result: unknown,
  captures: ReturnType<typeof createUsageCapture> | readonly ReturnType<typeof createUsageCapture>[] | (() => readonly ReturnType<typeof createUsageCapture>[]),
): unknown {
  const capturedUsage = () => {
    const captureList = hasRuntimeType(captures, "function")
      ? captures()
      : Array.isArray(captures) ? captures : [captures]
    return captureList.some(capture => capture.captured) ? combinedCapturedUsage(captureList) : undefined
  }
  if (result && hasRuntimeType(result, "object")) {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const record = result as Record<string, unknown>
    const originalValue = (key: "totalUsage" | "usage") => {
      let owner: object | null = record
      while (owner) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key)
        if (descriptor) {
          return {
            exists: true,
            read: descriptor.get
              ? () => descriptor.get?.call(record)
              : () => descriptor.value,
          }
        }
        // SAFETY: Prototype traversal either reaches another object in the chain or its null terminus.
        owner = Object.getPrototypeOf(owner) as object | null
      }
      return { exists: false, read: () => undefined }
    }
    const resultUsage = originalValue("usage")
    const totalUsage = originalValue("totalUsage")
    const hasTotalUsage = "totalUsage" in record
    const resolvedCapturedUsage = async (fallback: { exists: boolean, read: () => unknown }) => {
      if (hasRuntimeType(captures, "function")) {
        const [primaryCapture] = captures()
        if (!primaryCapture) return undefined
        if (!primaryCapture.captured && !fallback.exists) return undefined
        await primaryCapture.started
        await primaryCapture.completed
        // Output correction starts after the primary stream completes. Let the
        // materializer register that capture before taking the aggregate snapshot.
        await Promise.resolve()
        return await capturedUsage()
      }
      const fallbackUsage = fallback.exists ? await fallback.read() : undefined
      const usage = await capturedUsage()
      return usage ?? fallbackUsage
    }
    Object.defineProperty(record, "usage", {
      configurable: true,
      enumerable: true,
      get() {
        return resolvedCapturedUsage(resultUsage)
      },
    })
    if (hasTotalUsage) {
      Object.defineProperty(record, "totalUsage", {
        configurable: true,
        enumerable: true,
        get() {
          return resolvedCapturedUsage(totalUsage)
        },
      })
    }
    return result
  }

  const usage = capturedUsage()
  if (usage === undefined) return result

  return {
    raw: result,
    text: hasRuntimeType(result, "string") ? result : undefined,
    usage,
  }
}

function withCapturedStreamUsage<T extends {
  fullStream?: AsyncIterable<unknown>
  stream?: AsyncIterable<unknown>
  toUIMessageStream?: (...args: never[]) => ReadableStream<unknown>
}>(
  result: T,
  captures: () => readonly ReturnType<typeof createUsageCapture>[],
): T {
  const wrap = (getStream: () => AsyncIterable<unknown>): ReadableStream<unknown> => {
    let iterator: AsyncIterator<unknown> | undefined
    const getIterator = () => iterator ??= getStream()[Symbol.asyncIterator]()
    const primaryCapture = captures()[0]
    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      primaryCapture?.complete()
    }
    const wrapped: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]() {
        return wrapped
      },
      async next() {
        const iterator = getIterator()
        primaryCapture?.start()
        try {
          const result = await iterator.next()
          if (result.done) {
            complete()
            return result
          }
          const event = result.value
          if (event && hasRuntimeType(event, "object") && Reflect.get(event, "type") === "finish") {
            primaryCapture?.capture(event)
            const captureList = captures()
            const usage = await combinedCapturedUsage(captureList)
            if (usage !== undefined) {
              const usageRecord = await combinedUsageRecord(
                captureList.map(capture => ({ capture })),
                usage,
              )
              // SAFETY: AI SDK stream events are records after the object guard above.
              return { done: false, value: { ...(event as Record<string, unknown>), ...(usageRecord ? { usageRecord } : {}), usage } }
            }
          }
          return result
        }
        catch (error) {
          complete()
          throw error
        }
      },
      async return(value?: unknown) {
        const iterator = getIterator()
        primaryCapture?.start()
        try {
          return iterator.return ? await iterator.return(value) : { done: true, value }
        }
        finally {
          complete()
        }
      },
      async throw(error?: unknown) {
        const iterator = getIterator()
        primaryCapture?.start()
        try {
          if (iterator.throw) return await iterator.throw(error)
          await iterator.return?.()
          throw error
        }
        finally {
          complete()
        }
      },
    }
    return new ReadableStream({
      async pull(controller) {
        try {
          const item = await wrapped.next()
          if (item.done) controller.close()
          else controller.enqueue(item.value)
        }
        catch (error) {
          controller.error(error)
        }
      },
      async cancel(reason) {
        await wrapped.return?.(reason)
      },
    }, { highWaterMark: 0 })
  }
  const toUIMessageStream = result.toUIMessageStream
  const hasStream = "stream" in result
  const hasFullStream = "fullStream" in result
  if (!hasStream && !hasFullStream && !toUIMessageStream) return result
  const wrappedStream = hasStream ? wrap(() => result.stream!) : undefined
  const wrappedFullStream = hasFullStream ? wrap(() => result.fullStream!) : undefined
  return cloneStreamTextResult(result, {
    ...(wrappedStream ? { stream: wrappedStream } : {}),
    ...(wrappedFullStream ? { fullStream: wrappedFullStream } : {}),
    ...(toUIMessageStream
      ? {
          toUIMessageStream(this: typeof result, ...args: unknown[]) {
            let reader: ReadableStreamDefaultReader<unknown> | undefined
            // SAFETY: the wrapper forwards the original method's arguments without inspecting or changing them.
            const getReader = () => reader ??= toUIMessageStream.apply(this, args as never[]).getReader()
            return new ReadableStream({
              async pull(controller) {
                const reader = getReader()
                const primaryCapture = captures()[0]
                primaryCapture?.start()
                try {
                  const { done, value } = await reader.read()
                  if (done) {
                    primaryCapture?.complete()
                    controller.close()
                    return
                  }
                  if (value && hasRuntimeType(value, "object") && Reflect.get(value, "type") === "finish") {
                    primaryCapture?.capture(value)
                    const captureList = captures()
                    const usage = await combinedCapturedUsage(captureList)
                    const usageRecord = usage === undefined
                      ? undefined
                      : await combinedUsageRecord(captureList.map(capture => ({ capture })), usage)
                    // SAFETY: AI SDK UI-message finish chunks are records after the object guard above.
                    controller.enqueue({ ...(value as Record<string, unknown>), ...(usageRecord ? { usageRecord } : {}), ...(usage === undefined ? {} : { usage }) })
                    return
                  }
                  controller.enqueue(value)
                }
                catch (error) {
                  primaryCapture?.complete()
                  controller.error(error)
                }
              },
              async cancel(reason) {
                const primaryCapture = captures()[0]
                primaryCapture?.start()
                try {
                  await reader?.cancel(reason)
                }
                finally {
                  primaryCapture?.complete()
                }
              },
            }, { highWaterMark: 0 })
          },
        }
      : {}),
  }, false)
}

async function combinedUsageRecord(
  calls: Array<{ capture: ReturnType<typeof createUsageCapture>, result?: unknown }>,
  usage: unknown,
): Promise<AgentUsageRecord | undefined> {
  const records = (await Promise.all(calls.map(({ capture, result }) => resolveAgentUsageRecord(
    result === undefined ? capture.usageSource : withCapturedUsage(result, capture),
  )))).filter((record): record is AgentUsageRecord => Boolean(record))
  if (!records.length) return
  if (records.length === 1) return records[0]
  const shared = <K extends "credentialSource" | "model" | "transport">(key: K): AgentUsageRecord[K] | undefined => {
    const value = records[0]![key]
    return records.every(record => JSON.stringify(record[key]) === JSON.stringify(value)) ? value : undefined
  }
  const costs = records.flatMap(record => record.cost ? [record.cost] : [])
  const cost = costs.length === records.length ? aggregateAgentUsageCosts(costs) : undefined
  return {
    calls: records,
    ...(cost ? { cost } : {}),
    ...(shared("credentialSource") ? { credentialSource: shared("credentialSource") } : {}),
    ...(shared("model") ? { model: shared("model") } : {}),
    ...(shared("transport") ? { transport: shared("transport") } : {}),
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    usage: await usage as AgentUsageRecord["usage"],
  }
}

function readModelString(value: unknown, ...keys: string[]): string | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const item = record[key]
    if (hasRuntimeType(item, "string") && item) return item
  }
}

function withResolvedModelMetadata(result: unknown, model: unknown): unknown {
  const modelId = readModelString(model, "modelId", "model")
  const provider = readModelString(model, "provider", "providerId")
  if ((modelId === undefined && provider === undefined) || !result || !hasRuntimeType(result, "object")) {
    return result
  }

  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const existing = (settings.telemetry || settings.experimental_telemetry || {}) as {
    integrations?: unknown
    isEnabled?: boolean
    recordInputs?: boolean
    recordOutputs?: boolean
  }
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const globalIntegrations = Array.isArray((globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }).AI_SDK_TELEMETRY_INTEGRATIONS)
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
    }, new Map(Object.entries(context.tools || {}).flatMap(([name, tool]) => tool.activity ? [[name, tool.activity]] : [])))],
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
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
  if ((!defaultProviders || !hasRuntimeType(defaultProviders, "object"))
    && (!overrideProviders || !hasRuntimeType(overrideProviders, "object"))) return settings
  const providers = {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...(defaultProviders as Record<string, unknown> | undefined),
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...(overrideProviders as Record<string, unknown> | undefined),
  }
  for (const provider of new Set([
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...Object.keys((defaultProviders as Record<string, unknown> | undefined) || {}),
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...Object.keys((overrideProviders as Record<string, unknown> | undefined) || {}),
  ])) {
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const defaultSettings = (defaultProviders as Record<string, unknown> | undefined)?.[provider]
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    const overrideSettings = (overrideProviders as Record<string, unknown> | undefined)?.[provider]
    if ((defaultSettings && hasRuntimeType(defaultSettings, "object"))
      || (overrideSettings && hasRuntimeType(overrideSettings, "object"))) {
      providers[provider] = {
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        ...(defaultSettings as Record<string, unknown> | undefined),
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        ...(overrideSettings as Record<string, unknown> | undefined),
      }
    }
  }
  settings.providerOptions = providers
  return settings
}

function withoutToolCallSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const {
    activeTools: _activeTools,
    experimental_refineToolInput: _experimentalRefineToolInput,
    experimental_repairToolCall: _experimentalRepairToolCall,
    onToolExecutionEnd: _onToolExecutionEnd,
    onToolExecutionStart: _onToolExecutionStart,
    prepareStep: _prepareStep,
    repairToolCall: _repairToolCall,
    toolApproval: _toolApproval,
    toolChoice: _toolChoice,
    toolOrder: _toolOrder,
    tools: _tools,
    ...rest
  } = settings
  return rest
}

function withoutRepairConversationSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const {
    instructions: _instructions,
    messages: _messages,
    prompt: _prompt,
    ...rest
  } = withoutToolCallSettings(settings)
  return rest
}

function outputRepairPrompt(text: string, error: Error, evidence: string[] = []): string {
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return [
    "Correct the invalid final Agent output below.",
    "Return only the corrected JSON value. Do not repeat completed work.",
    `Validation error: ${cause || error.message}`,
    `Invalid output: ${JSON.stringify(text)}`,
    ...(evidence.length ? [`Completed tool results:\n${evidence.join("\n\n---\n\n")}`] : []),
  ].join("\n\n")
}

function toolCallRepairPrompt(toolCall: { input: unknown, toolName: string }, schema: JSONSchema7, error: Error): string {
  return [
    `Correct the invalid arguments for the tool "${toolCall.toolName}".`,
    "Return only arguments that match the tool schema. Do not choose another tool.",
    `Validation error: ${error.message}`,
    `Invalid arguments: ${JSON.stringify(toolCall.input)}`,
    `Tool schema: ${JSON.stringify(schema)}`,
  ].join("\n\n")
}

function outputMaxAttempts(output: AgentAdapterRunContext["output"]): number {
  const maxAttempts = output?.maxAttempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("[vitehub] Agent output maxAttempts must be a positive integer.")
  }
  return maxAttempts
}

async function createAgent(
  options: AiSdkAdapterOptions,
  context: AgentAdapterRunContext,
  fallbackCapture?: ReturnType<typeof createWorkspaceFallbackEvidenceCapture>,
  streamUsageCapture?: ReturnType<typeof createUsageCapture>,
) {
  const aiSdk = await loadAiSdk()
  const { ToolLoopAgent, isStepCount, jsonSchema } = aiSdk
  const execution = options.execution
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const metadataContext = {
    ...agentInvocationCallbackContextValues(context.context),
    ...runtime,
    actor: context.actor,
    context: context.context,
    fs: context.workspace?.fs,
    invoker: context.invoker,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const modelContext = {
    ...metadataContext,
    runtimeConfig: context.runtime.runtimeConfig,
  } as AgentModelResolverContext
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
  // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
  const telemetryModel = model && hasRuntimeType(model, "object") ? model as { modelId?: unknown, provider?: unknown } : undefined
  await updateAgentTelemetryConfiguration(context.context, {
    driver: {
      model: {
        ...(hasRuntimeType(telemetryModel?.modelId, "string") ? { id: telemetryModel.modelId } : {}),
        ...(hasRuntimeType(telemetryModel?.provider, "string") ? { provider: telemetryModel.provider } : {}),
      },
    },
    ...(instructions ? { instructions: [instructions] } : {}),
    ...(Object.keys(toolSet).length ? { tools: Object.keys(toolSet).sort().map(name => ({ name })) } : {}),
  })
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
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ...(Object.keys(toolSet).length ? { tools: toolSet as AgentToolSet } : {}),
  })
  const settings = instrumentedCallSettings ? { ...baseCallSettings, ...instrumentedCallSettings } : baseCallSettings
  const convertedOutputSchema = context.output && context.nativeStructuredOutput !== false ? agentOutputJsonSchema(context.output.schema) : undefined
  const outputSchema = convertedOutputSchema?.type === "object" ? convertedOutputSchema : undefined
  const nativeOutput = outputSchema ? aiSdk.Output.object({ schema: jsonSchema(outputSchema) }) : undefined
  const commonSettings = withRuntimeContext(withViteHubTelemetry(settings, context), context)
  // SAFETY: AI SDK call settings expose the stream chunk callback with this event shape.
  const configuredOnChunk = (commonSettings as { onChunk?: (event: unknown) => unknown }).onChunk
  const onChunk = streamUsageCapture
    ? async (event: unknown) => {
        if (event && hasRuntimeType(event, "object")) streamUsageCapture.capture(Reflect.get(event, "chunk"))
        await configuredOnChunk?.(event)
      }
    : configuredOnChunk
  const repairSettings = withoutToolCallSettings(commonSettings)
  const prepareCall = commonSettings.prepareCall
  const prepareRepairCall = hasRuntimeType(prepareCall, "function")
    ? async (input: Record<string, unknown>) => ({
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        ...withoutRepairConversationSettings(await prepareCall(input as never) as Record<string, unknown>),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      })
    : undefined
  const toolRepairUsageCaptures: Array<ReturnType<typeof createUsageCapture>> = []
  const builtInRepairToolCall: ToolCallRepairFunction<ToolSet> | undefined = Object.keys(toolSet).length
    ? async ({ error, inputSchema, toolCall, tools }) => {
        if (toolCall.providerExecuted || !Object.hasOwn(tools, toolCall.toolName)) return null
        const abortSignal = context.input.abortSignal
        try {
          abortSignal?.throwIfAborted()
          const schema = await inputSchema({ toolName: toolCall.toolName })
          abortSignal?.throwIfAborted()
          const usageCapture = createUsageCapture()
          toolRepairUsageCaptures.push(usageCapture)
          // SAFETY: AI SDK adapter normalization establishes the asserted agent settings contract.
          const toolRepairAgent = new ToolLoopAgent({
            ...repairSettings,
            instructions,
            // SAFETY: AI SDK adapter normalization establishes the asserted model contract.
            model: instrumentedModel as never,
            output: aiSdk.Output.object({ schema: jsonSchema(schema) }),
            ...(prepareRepairCall ? { prepareCall: prepareRepairCall } : {}),
            stopWhen: isStepCount(1),
          } as never)
          // SAFETY: The one-step repair agent returns the asserted generated result contract.
          const result = await toolRepairAgent.generate({
            ...(abortSignal ? { abortSignal } : {}),
            ...(context.input.timeout === undefined ? {} : { timeout: context.input.timeout }),
            ...("options" in context.input ? { options: context.input.options } : {}),
            onEnd: usageCapture.onEnd,
            onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
            onStepEnd: usageCapture.onStepEnd,
            prompt: toolCallRepairPrompt(toolCall, schema, error),
          } as never)
          return { ...toolCall, input: JSON.stringify(result.output) }
        }
        catch (error) {
          if (abortSignal?.aborted) throw abortSignal.reason ?? error
          return null
        }
      }
    : undefined
  const configuredRepairToolCall = commonSettings.repairToolCall ?? commonSettings.experimental_repairToolCall
  const repairToolCall = execution?.repairToolCall === false
    ? undefined
    : hasRuntimeType(execution?.repairToolCall, "function")
      ? execution.repairToolCall
      : configuredRepairToolCall ?? builtInRepairToolCall
  const maxOutputAttempts = context.output && context.nativeStructuredOutput !== false
    ? outputMaxAttempts(context.output)
    : 1
  const repairAgent = maxOutputAttempts > 1
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ? new ToolLoopAgent({
        ...repairSettings,
        instructions,
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        model: instrumentedModel as never,
        ...(nativeOutput ? { output: nativeOutput } : {}),
        ...(prepareRepairCall ? { prepareCall: prepareRepairCall } : {}),
        stopWhen: isStepCount(1),
      } as never)
    : undefined
  const repairOutput = repairAgent
    ? async (failure: { error: Error, evidence?: string[], text: string }, callInput: Record<string, unknown> | (() => Record<string, unknown>)): Promise<AgentAdapterResult> => {
        let latestFailure = failure
        for (let attempt = 1; attempt < maxOutputAttempts; attempt += 1) {
          const resolvedCallInput = hasRuntimeType(callInput, "function") ? callInput() : callInput
          const { messages: _messages, options: _options, prompt: _prompt, ...repairCallInput } = resolvedCallInput
          let repairResult: AgentAdapterResult | undefined
          try {
            // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
            repairResult = asUnknownBoundary(await repairAgent.generate({
              ...repairCallInput,
              ...("options" in resolvedCallInput ? { options: resolvedCallInput.options } : {}),
              prompt: outputRepairPrompt(latestFailure.text, latestFailure.error, latestFailure.evidence),
            } as never)) as AgentAdapterResult
            await validateAgentOutput(context.output!, repairResult)
            return repairResult
          }
          catch (repairError) {
            const repairedFailure = await nativeAgentOutputValidationFailure(context.output, repairError)
            const code = repairError !== null && hasRuntimeType(repairError, "object")
              ? Reflect.get(repairError, "code")
              : undefined
            if (!repairedFailure && code !== "AGENT_OUTPUT_INVALID_JSON" && code !== "AGENT_OUTPUT_SCHEMA_INVALID") {
              return await normalizeNativeAgentOutputError(context.output, repairError)
            }
            latestFailure = {
              ...(repairedFailure ?? {
                error: repairError instanceof Error ? repairError : new Error(String(repairError)),
                text: repairResult?.text ?? latestFailure.text,
              }),
              evidence: latestFailure.evidence,
            }
          }
        }
        throw latestFailure.error
      }
    : undefined

  return {
    agent: new ToolLoopAgent({
      ...commonSettings,
      ...(onChunk ? { onChunk } : {}),
      instructions,
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      model: instrumentedModel as never,
      ...(nativeOutput ? { output: nativeOutput } : {}),
      experimental_repairToolCall: undefined,
      // SAFETY: Repair selection above normalizes every supported repair callback to the AI SDK contract.
      repairToolCall: repairToolCall as never,
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      stopWhen: ((settings as Record<string, unknown>).stopWhen ?? isStepCount(stepLimit ?? 20)) as never,
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      ...(Object.keys(toolSet).length ? { tools: toolSet as never } : {}),
    }),
    model: instrumentedModel,
    repairOutput,
    toolRepairUsageCaptures,
    tools: Object.keys(toolSet).length ? toolSet : undefined,
  }
}

export function createAiSdkAdapter(options: AiSdkAdapterOptions): AgentAdapter {
  const staticTools = hasRuntimeType(options.tools, "object") && options.tools
    // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
    ? withAgentToolStepReporting(withJsonCompatibleToolOutputs(applyAgentToolPolicies(options.tools as AgentToolSet) || {}))
    : undefined
  return markMessageChannelInstructionConsumer({
    async generate(context) {
      const execution = options.execution
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      const callInput = await getCallInput(context, execution?.attachments) as Record<string, unknown>
      const fallback = getFallbackOptions(execution?.workspaceFallback)
      const fallbackCapture = fallback.enabled || Boolean(context.output)
        ? createWorkspaceFallbackEvidenceCapture(fallback.enabled ? fallback.maxToolResults : 8)
        : undefined
      const { agent, model, repairOutput, toolRepairUsageCaptures, tools } = await createAgent(options, context, fallbackCapture)
      if (context.workspace && tools && "materialize_sources" in tools) {
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        await reportWorkspaceMaterialization(tools as AgentToolSet, context.toolStepReporter)
      }
      const usageCapture = createUsageCapture()
      const repairUsageCaptures: Array<ReturnType<typeof createUsageCapture>> = []
      const fallbackUsageCapture = createUsageCapture()
      const repairCallInput = () => {
        const usageCapture = createUsageCapture()
        repairUsageCaptures.push(usageCapture)
        return {
          ...callInput,
          onEnd: usageCapture.onEnd,
          onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
          onStepEnd: usageCapture.onStepEnd,
        }
      }
      const captureOriginalStep = async (event: unknown) => {
        await usageCapture.onStepEnd(event)
        fallbackCapture?.collect(event)
      }
      const originalCallInput = {
        ...callInput,
        onEnd: usageCapture.onEnd,
        onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
        onStepEnd: captureOriginalStep,
      }
      let generated: GenerateTextResult<ToolSet, never, never>
      let originalGenerated: GenerateTextResult<ToolSet, never, never> | undefined
      let repaired = false
      const synthesizedOutput = async (synthesized: { result: unknown, text: string }, original?: unknown, repairResult?: unknown) => {
        const captures = [usageCapture, ...toolRepairUsageCaptures, ...repairUsageCaptures, fallbackUsageCapture]
        let usageRecord: AgentUsageRecord | undefined
        if (fallbackUsageCapture.captured) {
          const calls = [
            { capture: usageCapture, result: originalGenerated ?? original },
            ...toolRepairUsageCaptures.map(capture => ({ capture })),
            { capture: fallbackUsageCapture, result: synthesized.result },
            ...repairUsageCaptures.map((capture, index) => ({
              capture,
              ...(index === repairUsageCaptures.length - 1 ? { result: repairResult } : {}),
            })),
          ]
          usageRecord = await combinedUsageRecord(calls, combinedCapturedUsage(captures))
        }
        const raw = withCapturedUsage(original, captures)
        if (raw && hasRuntimeType(raw, "object") && usageRecord) {
          Object.defineProperty(raw, "usageRecord", {
            configurable: true,
            enumerable: true,
            value: usageRecord,
          })
        }
        const output = { raw, text: synthesized.text }
        if (usageRecord) {
          Object.defineProperty(output, "usageRecord", {
            configurable: true,
            enumerable: true,
            value: usageRecord,
          })
        }
        Object.defineProperty(output, synthesizedAgentOutputSymbol, { value: true })
        return output
      }
      const validatedSynthesizedOutput = async (synthesized: { result: unknown, text: string }, original?: unknown) => {
        if (!repairOutput || !context.output) return await synthesizedOutput(synthesized, original)
        try {
          await validateAgentOutput(context.output, synthesized.result)
          return await synthesizedOutput(synthesized, original)
        }
        catch (error) {
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          const repairResult = await repairOutput({
            error: error instanceof Error ? error : new Error(String(error)),
            evidence: fallbackCapture?.evidence(),
            text: synthesized.text,
          }, repairCallInput) as GenerateTextResult<ToolSet, never, never>
          return await synthesizedOutput({ ...synthesized, text: repairResult.text }, original, repairResult)
        }
      }
      try {
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        generated = await agent.generate(originalCallInput as never) as GenerateTextResult<ToolSet, never, never>
        originalGenerated = generated
      }
      catch (error) {
        const failure = await nativeAgentOutputValidationFailure(context.output, error)
        const synthesized = failure && fallback.enabled && !failure.text.trim()
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          ? await synthesizeWorkspaceFallbackFromEvidence(model as never, context, fallbackCapture?.evidence() ?? [], fallbackUsageCapture)
          : undefined
        if (synthesized) return await validatedSynthesizedOutput(synthesized)
        const repairedOutput = failure && repairOutput
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          ? await repairOutput({ ...failure, evidence: fallbackCapture?.evidence() }, repairCallInput) as GenerateTextResult<ToolSet, never, never>
          : undefined
        generated = repairedOutput ?? await normalizeNativeAgentOutputError(context.output, error)
        repaired = Boolean(repairedOutput)
      }
      if (!repaired && fallback.enabled && (generated.finishReason === "tool-calls" || !generated.text.trim() && hasToolResults(generated))) {
        // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
        const synthesized = await synthesizeWorkspaceFallback(model as never, context, generated, fallback.maxToolResults, fallbackUsageCapture)
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          ?? await synthesizeWorkspaceFallbackFromEvidence(model as never, context, fallbackCapture?.evidence() ?? [], fallbackUsageCapture)
        if (synthesized) return await validatedSynthesizedOutput(synthesized, generated)
      }
      if (!repaired && repairOutput && context.output) {
        try {
          await validateAgentOutput(context.output, generated)
        }
        catch (error) {
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          generated = await repairOutput({
            error: error instanceof Error ? error : new Error(String(error)),
            evidence: fallbackCapture?.evidence(),
            text: generated.text,
          }, repairCallInput) as GenerateTextResult<ToolSet, never, never>
        }
      }
      const auxiliaryUsageCaptures = [...toolRepairUsageCaptures, ...repairUsageCaptures]
      const usageRecord = auxiliaryUsageCaptures.some(capture => capture.captured)
        ? await combinedUsageRecord([
            { capture: usageCapture, result: originalGenerated },
            ...auxiliaryUsageCaptures.map((capture, index) => ({
              capture,
              ...(index === auxiliaryUsageCaptures.length - 1 ? { result: generated } : {}),
            })),
          ], combinedCapturedUsage([usageCapture, ...auxiliaryUsageCaptures]))
        : undefined
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      const result = withResolvedModelMetadata(withCapturedUsage(generated, [usageCapture, ...auxiliaryUsageCaptures]), model) as GenerateTextResult<ToolSet, never, never>
      if (usageRecord) {
        Object.defineProperty(result, "usageRecord", {
          configurable: true,
          enumerable: true,
          value: usageRecord,
        })
      }
      const text = result.text.trim()
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      if (text) return asUnknownBoundary(result) as AgentAdapterResult

      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      return asUnknownBoundary(result) as AgentAdapterResult
    },
    async metadata(context) {
      const instructions = await resolveInstructions(options, context)
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      const tools = options.tools ? await resolveValue(options.tools as never, context) : undefined
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      const metadataTools = tools as AgentToolSet | undefined
      return {
        instructions: instructions ? [instructions] : [],
        tools: Object.entries(metadataTools || {}).map(([name, tool]) => ({
          category: "workspace",
          description: tool.description,
          icon: name === "shell" ? "i-lucide-terminal" : "i-lucide-wrench",
          name,
          preset: "vitehub-workspace",
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
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
      const fallbackCapture = fallback.enabled || Boolean(context.output)
        ? createWorkspaceFallbackEvidenceCapture(fallback.enabled ? fallback.maxToolResults : 8)
        : undefined
      const { agent, model, repairOutput, toolRepairUsageCaptures } = await createAgent(options, context, fallbackCapture, usageCapture)
      const captureStep = async (event: unknown) => {
        await usageCapture.onStepEnd(event)
        fallbackCapture?.collect(event)
      }
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      const callInput = await getCallInput(context, execution?.attachments) as Record<string, unknown>
      const repairUsageCaptures: Array<ReturnType<typeof createUsageCapture>> = []
      const repairCallInput = () => {
        const repairUsageCapture = createUsageCapture()
        repairUsageCaptures.push(repairUsageCapture)
        return {
          ...callInput,
          onEnd: repairUsageCapture.onEnd,
          onLanguageModelCallEnd: repairUsageCapture.onLanguageModelCallEnd,
          onStepEnd: repairUsageCapture.onStepEnd,
        }
      }
      const usageCaptures = () => [usageCapture, ...toolRepairUsageCaptures, ...repairUsageCaptures]
      let started: Promise<StreamTextResult<ToolSet, never, never>> | undefined
      let resolveStarted!: (result: Promise<StreamTextResult<ToolSet, never, never>>) => void
      const whenStarted = new Promise<StreamTextResult<ToolSet, never, never>>((resolve) => {
        resolveStarted = resolve
      })
      // SAFETY: createAgent returns the AI SDK Agent contract, and getCallInput returns its normalized call input.
      const start = () => {
        if (started) return started
        started = Promise.resolve(agent.stream({
          ...callInput,
          onEnd: usageCapture.onEnd,
          onLanguageModelCallEnd: usageCapture.onLanguageModelCallEnd,
          onStepEnd: captureStep,
        } as never) as Promise<StreamTextResult<ToolSet, never, never>>).then((streamed) => {
          // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
          return withResolvedModelMetadata(withCapturedStreamUsage(
            // SAFETY: withCapturedUsage preserves the streamed result object and only replaces its usage accessors.
            withCapturedUsage(streamed, usageCaptures) as StreamTextResult<ToolSet, never, never>,
            usageCaptures,
          ), model) as StreamTextResult<ToolSet, never, never>
        })
        resolveStarted(started)
        return started
      }
      const lazyStream = (property: "fullStream" | "stream" | "textStream"): ReadableStream<unknown> => {
        let reader: ReadableStreamDefaultReader<unknown> | undefined
        const getReader = async () => {
          if (reader) return reader
          const result = await start()
          const stream = result[property] ?? result.stream ?? result.fullStream ?? result.textStream
          reader = stream instanceof ReadableStream
            ? stream.getReader()
            // SAFETY: StreamTextResult exposes these properties as ReadableStream or AsyncIterable values.
            : ReadableStream.from(stream as AsyncIterable<unknown>).getReader()
          return reader
        }
        return new ReadableStream({
          async pull(controller) {
            const item = await (await getReader()).read()
            if (item.done) controller.close()
            else controller.enqueue(item.value)
          },
          async cancel(reason) {
            await (await getReader()).cancel(reason)
          },
        }, { highWaterMark: 0 })
      }
      // SAFETY: The lazy facade implements the StreamTextResult members consumed by the adapter.
      const result = asUnknownBoundary({
        fullStream: lazyStream("fullStream"),
        stream: lazyStream("stream"),
        get textStream() {
          return lazyStream("textStream")
        },
        get usage() {
          return whenStarted.then(result => result.usage)
        },
        get totalUsage() {
          return whenStarted.then(result => result.totalUsage)
        },
        toUIMessageStream(...args: unknown[]) {
          let reader: ReadableStreamDefaultReader<unknown> | undefined
          return new ReadableStream<unknown>({
            async pull(controller) {
              // SAFETY: toUIMessageStream forwards the AI SDK method's argument tuple unchanged.
              reader ??= (await start()).toUIMessageStream(...args as never[]).getReader()
              const item = await reader.read()
              if (item.done) controller.close()
              else controller.enqueue(item.value)
            },
            async cancel(reason) {
              await reader?.cancel(reason)
            },
          }, { highWaterMark: 0 })
        },
      }) as StreamTextResult<ToolSet, never, never>
      const cancelStarted = async () => {
        const streamed = await start()
        const candidates = [streamed.stream, streamed.fullStream]
        await Promise.allSettled(candidates.map(async (candidate) => {
          const iterator = candidate?.[Symbol.asyncIterator]()
          await iterator?.return?.()
        }))
      }
      if (context.input.abortSignal?.aborted) void cancelStarted()
      else context.input.abortSignal?.addEventListener("abort", () => void cancelStarted(), { once: true })
      if (repairOutput && context.output) {
        Object.defineProperty(result, agentOutputRepairSymbol, {
          configurable: true,
          value: async (failure: { error: Error, text: string }) => await repairOutput({
            ...failure,
            evidence: fallbackCapture?.evidence(),
          }, repairCallInput),
        })
      }
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      return withWorkspaceFallbackStreamResult(result, model as never, context, fallback, fallbackCapture?.evidence)
    },
  })
}

export function fromAiSdkAgent(agent: Agent): AgentAdapter {
  return {
    async generate(context) {
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      return await agent.generate(await getCallInput(context) as never)
    },
    name: "ai-sdk",
    async stream(context) {
      // SAFETY: AI SDK adapter normalization establishes the asserted model and result contract.
      return await agent.stream(await getCallInput(context) as never)
    },
  }
}
