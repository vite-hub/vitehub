import { ApprovalRequiredError } from "@vite-hub/runtime"
import { isAsyncIterable } from "./internal/stream-result.ts"

import type { StreamEvent } from "./messages.ts"
import type { AgentRunResult, AgentUsage, AgentUsageRecord } from "./types.ts"

export { isAsyncIterable } from "./internal/stream-result.ts"

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return

  const text = content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []

    const record = part as Record<string, unknown>
    if (record.type !== "text" && record.type !== "text-delta") return []

    const value = record.text ?? record.textDelta ?? record.delta
    return typeof value === "string" ? [value] : []
  }).join("")

  return text ? text : undefined
}

function textFromResult(result: Record<string, unknown>): string | undefined {
  if (typeof result.text === "string") return result.text
  if (typeof result.output === "string") return result.output
  if (typeof result._output === "string") return result._output
  const contentText = textFromContent(result.content)
  if (contentText) return contentText

  const steps = result.steps
  if (Array.isArray(steps)) {
    for (const step of steps.slice().reverse()) {
      if (step && typeof step === "object" && typeof (step as { text?: unknown }).text === "string") {
        return (step as { text: string }).text
      }
      const stepContentText = textFromContent((step as { content?: unknown }).content)
      if (stepContentText) return stepContentText
    }
  }
}

export function toAgentRunResult(value: unknown): AgentRunResult {
  if (typeof value !== "object" || value === null) {
    return { raw: value, text: typeof value === "string" ? value : undefined }
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: value,
    text: textFromResult(result),
    usage: result.usage,
    usageRecord: result.usageRecord as AgentUsageRecord | undefined,
    warnings: result.warnings,
  }
}

function isUsageRecord(value: unknown): value is AgentUsageRecord {
  return typeof value === "object" && value !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
}

function readDetails(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return
  const details: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) details[key] = item
  }
  return Object.keys(details).length ? details : undefined
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function"
}

async function resolveUsageValue(value: unknown): Promise<unknown> {
  return isPromiseLike(value) ? await value : value
}

function modelFromResult(result: unknown): AgentUsageRecord["model"] | undefined {
  if (!isRecord(result)) return
  const response = isRecord(result.response) ? result.response : undefined
  const id = readString(response, "modelId", "model") ?? readString(result, "modelId", "model")
  const provider = readString(result, "provider")
  if (id === undefined && provider === undefined) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(provider !== undefined ? { provider } : {}),
  }
}

function responseFromResult(result: unknown): AgentUsageRecord["response"] | undefined {
  if (!isRecord(result)) return
  const response = isRecord(result.response) ? result.response : undefined
  const id = readString(response, "id")
  const timestamp = response?.timestamp
  const finishReason = result.finishReason
  if (id === undefined && timestamp === undefined) return
  return {
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(id !== undefined ? { id } : {}),
    ...((timestamp instanceof Date || typeof timestamp === "string") ? { timestamp } : {}),
  }
}

function usageRecordFromUsage(rawUsage: unknown, metadataSource?: unknown, fallbackMetadataSource?: unknown): AgentUsageRecord | undefined {
  if (!isRecord(rawUsage)) return
  const inputTokens = readNumber(rawUsage, "inputTokens", "promptTokens", "input_tokens", "prompt_tokens")
  const outputTokens = readNumber(rawUsage, "outputTokens", "completionTokens", "output_tokens", "completion_tokens")
  const totalTokens = readNumber(rawUsage, "totalTokens", "tokens", "total_tokens")
    ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const inputTokenDetails = readDetails(rawUsage.inputTokenDetails || rawUsage.input_token_details || rawUsage.promptTokenDetails || rawUsage.prompt_token_details)
  const outputTokenDetails = readDetails(rawUsage.outputTokenDetails || rawUsage.output_token_details || rawUsage.completionTokenDetails || rawUsage.completion_token_details)
  const usage: AgentUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokenDetails ? { inputTokenDetails } : {}),
    ...(outputTokenDetails ? { outputTokenDetails } : {}),
  }
  if (!Object.keys(usage).length) return
  const model = modelFromResult(metadataSource) ?? modelFromResult(fallbackMetadataSource)
  const response = responseFromResult(metadataSource) ?? responseFromResult(fallbackMetadataSource)
  return {
    ...(model ? { model } : {}),
    ...(response ? { response } : {}),
    usage,
  }
}

function withFallbackUsageMetadata(record: AgentUsageRecord, fallbackMetadataSource: unknown): AgentUsageRecord {
  const model = record.model ?? modelFromResult(fallbackMetadataSource)
  const response = record.response ?? responseFromResult(fallbackMetadataSource)
  return model || response
    ? {
        ...record,
        ...(model ? { model } : {}),
        ...(response ? { response } : {}),
      }
    : record
}

function usageFromStreamChunk(chunk: unknown, fallbackMetadataSource?: unknown): AgentUsageRecord | undefined {
  if (!isRecord(chunk)) return
  const type = String(chunk.type || "")
  return usageRecordFromUsage(type === "finish-step"
    ? chunk.usage
    : type === "finish"
      ? chunk.usage ?? chunk.totalUsage
      : undefined, chunk, fallbackMetadataSource)
}

async function usageFromResult(result: unknown): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(result)) return
  return usageRecordFromUsage(await resolveUsageValue(result.usage ?? result.totalUsage), result)
}

function optionalMessageId(messageId: string | undefined): { messageId?: string } {
  return messageId ? { messageId } : {}
}

export function toAgentStreamEvent(chunk: unknown, toolNames?: Map<string, string>): StreamEvent | undefined {
  if (typeof chunk === "string") {
    return { text: chunk, type: "text-delta" }
  }
  if (!chunk || typeof chunk !== "object") {
    return undefined
  }

  const value = chunk as Record<string, unknown>
  const type = String(value.type || "")
  const messageId = typeof value.messageId === "string" ? value.messageId : undefined
  if (type === "text-delta" || type === "text") {
    return { id: value.id as string | undefined, ...optionalMessageId(messageId), ...(typeof value.role === "string" ? { role: value.role as never } : {}), text: String(value.text || value.textDelta || value.delta || ""), type: "text-delta" }
  }
  if (type === "data") {
    return { data: value.data, id: value.id as string | undefined, ...optionalMessageId(messageId), type: "data" }
  }
  if (type === "tool-input-start") {
    const id = String(value.id || value.toolCallId)
    const name = String(value.toolName || value.name || toolNames?.get(id) || "tool")
    toolNames?.set(id, name)
    return { id, input: value.input, ...optionalMessageId(messageId), name, type: "tool-input-start" }
  }
  if (type === "tool-call" || type === "tool-input-available") {
    const id = String(value.toolCallId ?? value.id)
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    toolNames?.set(id, name)
    return { id, input: value.input ?? value.args, ...optionalMessageId(messageId), name, type: "tool-call" }
  }
  if (type === "tool-result" || type === "tool-output-available") {
    const id = String(value.toolCallId ?? value.id)
    return { error: typeof value.error === "string" ? value.error : undefined, id, ...optionalMessageId(messageId), name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "tool-error" || type === "tool-output-error") {
    const id = String(value.toolCallId ?? value.id)
    const error = value.error instanceof Error
      ? value.error.message
      : typeof value.errorText === "string"
        ? value.errorText
        : String(value.error || "Unknown tool error")
    return { error, id, ...optionalMessageId(messageId), name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "approval-request") {
    return { id: String(value.id), input: value.input, ...optionalMessageId(messageId), name: String(value.name || "approval"), reason: typeof value.reason === "string" ? value.reason : undefined, type: "approval-request" }
  }
  if (type === "approval-decision") {
    return { approved: value.approved === true, decidedAt: value.decidedAt as Date | string | undefined, id: String(value.id), ...optionalMessageId(messageId), reason: typeof value.reason === "string" ? value.reason : undefined, type: "approval-decision" }
  }
  if (type === "error") {
    if (value.error instanceof ApprovalRequiredError) {
      const { request } = value.error
      return { id: request.id, input: request.input, ...optionalMessageId(messageId), name: request.capability || request.id, reason: request.reason, type: "approval-request" }
    }
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), ...(typeof value.id === "string" ? { id: value.id } : {}), ...optionalMessageId(messageId), ...(value.recoverable === true ? { recoverable: true } : {}), type: "error" }
  }
  if (type === "usage" && isUsageRecord(value.usageRecord)) {
    return { ...optionalMessageId(messageId), type: "usage", usageRecord: value.usageRecord }
  }
  if (type === "finish") {
    const reason = typeof value.finishReason === "string" ? value.finishReason : typeof value.reason === "string" ? value.reason : undefined
    return { ...optionalMessageId(messageId), ...(reason ? { reason } : {}), type: "finish" }
  }
  return undefined
}

async function* streamChunksToEvents(chunks: AsyncIterable<unknown>, usageSource?: unknown): AsyncIterable<StreamEvent> {
  const toolNames = new Map<string, string>()
  let usageRecord: AgentUsageRecord | undefined
  let explicitUsageEvent = false
  let finishEvent: StreamEvent | undefined
  for await (const chunk of chunks) {
    if (!explicitUsageEvent) usageRecord = usageFromStreamChunk(chunk, usageSource) ?? usageRecord
    const event = toAgentStreamEvent(chunk, toolNames)
    if (!event) continue
    if (event.type === "usage") {
      usageRecord = withFallbackUsageMetadata(event.usageRecord, usageSource)
      explicitUsageEvent = true
      continue
    }
    if (event.type === "finish") {
      finishEvent = event
      continue
    }
    yield event
  }
  usageRecord ??= await usageFromResult(usageSource)
  if (usageRecord) yield { type: "usage", usageRecord }
  yield finishEvent ?? { type: "finish" }
}

export async function* streamAgentOutputToEvents(value: unknown): AsyncIterable<StreamEvent> {
  if (typeof value === "string") {
    if (value) yield { text: value, type: "text-delta" }
    yield { type: "finish" }
    return
  }
  if (value instanceof Response) {
    const text = await value.text()
    if (text) yield { text, type: "text-delta" }
    yield { type: "finish" }
    return
  }
  const result = value && typeof value === "object"
    ? value as { fullStream?: unknown, stream?: unknown, textStream?: unknown }
    : undefined
  if (isAsyncIterable(result?.stream)) {
    yield* streamChunksToEvents(result.stream, result)
    return
  }
  const fullStream = result?.fullStream
  if (isAsyncIterable(fullStream)) {
    yield* streamChunksToEvents(fullStream, result)
    return
  }
  if (isAsyncIterable<string>(result?.textStream)) {
    for await (const text of result.textStream) {
      yield { text, type: "text-delta" }
    }
    let usageRecord = isUsageRecord((value as { usageRecord?: unknown }).usageRecord)
      ? (value as { usageRecord: AgentUsageRecord }).usageRecord
      : await usageFromResult(value)
    if (!usageRecord && isRecord(value)) usageRecord = await usageFromResult(value.raw)
    if (usageRecord) yield { type: "usage", usageRecord }
    yield { type: "finish" }
    return
  }
  if (isAsyncIterable(value)) {
    yield* streamChunksToEvents(value as AsyncIterable<unknown>)
    return
  }
  const text = typeof value === "object" && value !== null
    ? textFromResult(value as Record<string, unknown>)
    : undefined
  if (typeof text === "string") {
    if (text) yield { text, type: "text-delta" }
    let usageRecord = isUsageRecord((value as { usageRecord?: unknown }).usageRecord)
      ? (value as { usageRecord: AgentUsageRecord }).usageRecord
      : await usageFromResult(value)
    if (!usageRecord && isRecord(value)) {
      usageRecord = await usageFromResult((value as { raw?: unknown }).raw)
    }
    if (usageRecord) {
      yield { type: "usage", usageRecord }
    }
    yield {
      reason: typeof (value as { finishReason?: unknown }).finishReason === "string"
        ? (value as { finishReason: string }).finishReason
        : undefined,
      type: "finish",
    }
  }
}
