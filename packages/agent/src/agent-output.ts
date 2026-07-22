import { getViteHubErrorShape } from "@vite-hub/runtime"
import { publishedDeliveryArtifactsFromUnknown } from "./delivery-artifacts.ts"
import { readAgentUsageMetadata } from "./internal/agent-usage-metadata.ts"
import { isAsyncIterable } from "./internal/stream-result.ts"
import { finalChannelOutputSelectedSymbol } from "./internal/final-channel-output.ts"
import { synthesizedAgentOutputSymbol } from "./internal/synthesized-agent-output.ts"

import type { StreamEvent } from "./messages.ts"
import type { AgentRunMetadata, AgentRunResult, AgentUsage, AgentUsageRecord } from "./types.ts"

export { isAsyncIterable } from "./internal/stream-result.ts"

export function agentResultKind(result: unknown): string {
  if (result === null) return "null"
  if (isAsyncIterable(result)) return "stream"
  if (Array.isArray(result)) return "array"
  return typeof result
}

export function hasTraceableStreamResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isAsyncIterable(value.fullStream) || isAsyncIterable(value.stream) || isAsyncIterable(value.textStream)
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return

  const text = content.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []

    const record = part as Record<string, unknown>
    const type = ownValue(record, "type")
    if (type !== "text" && type !== "text-delta") return []

    const value = ownValue(record, "text") ?? ownValue(record, "textDelta") ?? ownValue(record, "delta")
    return typeof value === "string" ? [value] : []
  }).join("")

  return text ? text : undefined
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function textFromResult(result: Record<string, unknown>): string | undefined {
  const text = ownValue(result, "text")
  if (typeof text === "string" && text) return text
  const output = ownValue(result, "output")
  if (typeof output === "string" && output) return output
  const rawOutput = ownValue(result, "_output")
  if (typeof rawOutput === "string" && rawOutput) return rawOutput
  const contentText = textFromContent(ownValue(result, "content"))
  if (contentText) return contentText

  const steps = ownValue(result, "steps")
  if (Array.isArray(steps)) {
    for (const step of steps.slice().reverse()) {
      if (step && typeof step === "object") {
        const record = step as Record<string, unknown>
        const stepText = ownValue(record, "text")
        if (typeof stepText === "string" && stepText) return stepText
        const stepContentText = textFromContent(ownValue(record, "content"))
        if (stepContentText) return stepContentText
      }
    }
  }
}

function finalTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return

  const boundary = content.findLastIndex((part) => {
    if (!part || typeof part !== "object") return false
    const type = ownValue(part as Record<string, unknown>, "type")
    return typeof type === "string" && type.startsWith("tool-")
  })
  return boundary >= 0 ? textFromContent(content.slice(boundary + 1)) ?? "" : undefined
}

function contentFromSteps(steps: unknown[]): unknown[] {
  return steps.flatMap((step) => {
    if (!isRecord(step)) return []
    const content = ownValue(step, "content")
    const text = ownValue(step, "text")
    if (!Array.isArray(content)) return typeof text === "string" && text ? [{ text, type: "text" }] : []
    return typeof text === "string" && text && textFromContent(content) === undefined
      ? [...content, { text, type: "text" }]
      : content
  })
}

function structuredTextFromResult(result: Record<string, unknown>): string | undefined {
  const content = textFromContent(ownValue(result, "content"))
  if (content !== undefined) return content

  const steps = ownValue(result, "steps")
  if (!Array.isArray(steps)) return
  return textFromContent(contentFromSteps(steps))
}

function finalTextFromStructuredResult(result: Record<string, unknown>): string | undefined {
  const content = finalTextFromContent(ownValue(result, "content"))
  if (content !== undefined) return content

  const steps = ownValue(result, "steps")
  if (!Array.isArray(steps)) return
  return finalTextFromContent(contentFromSteps(steps))
}

export function finalTextFromAgentOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return

  const raw = ownValue(value, "raw")
  if (isRecord(raw)) {
    const final = finalTextFromStructuredResult(raw)
    if (final === "" && Object.getOwnPropertyDescriptor(value, synthesizedAgentOutputSymbol)?.value === true) {
      return textFromResult(value) ?? final
    }
    return final ?? textFromResult(value)
  }

  const final = finalTextFromStructuredResult(value)
  if (final !== "") return final ?? textFromResult(value)

  const text = textFromResult(value)
  const structuredText = structuredTextFromResult(value)
  return text && structuredText !== text ? text : final
}

export function toAgentRunResult(value: unknown): AgentRunResult {
  if (typeof value !== "object" || value === null) {
    return { raw: value, text: typeof value === "string" ? value : undefined }
  }

  const result = value as Record<string, unknown>
  const explicitText = ownValue(result, "text")
  const selectedChannelOutput = Object.getOwnPropertyDescriptor(result, finalChannelOutputSelectedSymbol)?.value === true
  const raw = selectedChannelOutput ? ownValue(result, "raw") : value
  const normalized = selectedChannelOutput && isRecord(raw) ? raw : result
  const selectedValue = (key: string) => ownValue(result, key) ?? ownValue(normalized, key)
  const usageRecord = isUsageRecord(selectedValue("usageRecord"))
    ? withFallbackUsageMetadata(withFallbackUsageMetadata(selectedValue("usageRecord") as AgentUsageRecord, result), normalized)
    : usageRecordFromUsage(selectedValue("usage") ?? selectedValue("totalUsage"), result, normalized)
  const artifacts = publishedDeliveryArtifactsFromUnknown(selectedValue("artifacts"))
  return {
    ...(artifacts.length ? { artifacts } : {}),
    finishReason: selectedValue("finishReason"),
    raw,
    text: selectedChannelOutput && typeof explicitText === "string" ? explicitText : textFromResult(result),
    usage: selectedValue("usage") ?? usageRecord?.usage,
    usageRecord,
    warnings: selectedValue("warnings"),
  }
}

function isUsageRecord(value: unknown): value is AgentUsageRecord {
  if (!isRecord(value)) return false
  return ["cost", "credentialSource", "latency", "model", "raw", "response", "run", "usage"].some(key => key in value)
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

function credentialSourceFromMetadata(metadata: unknown): AgentUsageRecord["credentialSource"] | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.credentialSource)) return
  const source = metadata.credentialSource.source
  const label = metadata.credentialSource.label
  if (source !== undefined && typeof source !== "string") return
  if (label !== undefined && typeof label !== "string") return
  if (source === undefined && label === undefined) return
  return {
    ...(label ? { label } : {}),
    ...(source ? { source: source as NonNullable<AgentUsageRecord["credentialSource"]>["source"] } : {}),
  }
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

function latencyFromResult(result: unknown): AgentUsageRecord["latency"] | undefined {
  if (!isRecord(result)) return
  const source = isRecord(result.latency) ? result.latency : result
  const durationMs = readNumber(source, "durationMs", "duration_ms")
  const timeToFirstTokenMs = readNumber(source, "timeToFirstTokenMs", "ttftMs", "time_to_first_token_ms")
  const tokensPerSecond = readNumber(source, "tokensPerSecond", "tokens_per_second")
  if (durationMs === undefined && timeToFirstTokenMs === undefined && tokensPerSecond === undefined) return
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  }
}

function usageRecordFromUsage(
  rawUsage: unknown,
  metadataSource?: unknown,
  fallbackMetadataSource?: unknown,
  run?: Partial<AgentRunMetadata>,
): AgentUsageRecord | undefined {
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
  if (!Object.keys(usage).length) {
    if (!Object.keys(rawUsage).length) return
    usage.details = rawUsage
  }
  const model = modelFromResult(metadataSource) ?? modelFromResult(fallbackMetadataSource)
  const response = responseFromResult(metadataSource) ?? responseFromResult(fallbackMetadataSource)
  const latency = latencyFromResult(metadataSource) ?? latencyFromResult(fallbackMetadataSource)
  const credentialSource = credentialSourceFromMetadata(readAgentUsageMetadata(metadataSource, fallbackMetadataSource))
  return {
    ...(credentialSource ? { credentialSource } : {}),
    ...(latency ? { latency } : {}),
    ...(model ? { model } : {}),
    ...(response ? { response } : {}),
    ...(run ? { run } : {}),
    usage,
  }
}

function withFallbackUsageMetadata(
  record: AgentUsageRecord,
  fallbackMetadataSource: unknown,
  run?: Partial<AgentRunMetadata>,
): AgentUsageRecord {
  const model = record.model ?? modelFromResult(fallbackMetadataSource)
  const response = record.response ?? responseFromResult(fallbackMetadataSource)
  const latency = record.latency ?? latencyFromResult(fallbackMetadataSource)
  const credentialSource = record.credentialSource ?? credentialSourceFromMetadata(readAgentUsageMetadata(record, fallbackMetadataSource))
  const runMetadata = record.run ?? run
  return model || response || latency || credentialSource || runMetadata
    ? {
        ...record,
        ...(credentialSource ? { credentialSource } : {}),
        ...(latency ? { latency } : {}),
        ...(model ? { model } : {}),
        ...(response ? { response } : {}),
        ...(runMetadata ? { run: runMetadata } : {}),
      }
    : record
}

export function usageRecordFromStreamChunk(chunk: unknown, fallbackMetadataSource?: unknown, run?: Partial<AgentRunMetadata>): AgentUsageRecord | undefined {
  if (!isRecord(chunk)) return
  const type = String(chunk.type || "")
  if (type === "usage" && isUsageRecord(chunk.usageRecord)) {
    return withFallbackUsageMetadata(chunk.usageRecord, fallbackMetadataSource, run)
  }
  return usageRecordFromUsage(type === "finish-step"
    ? chunk.usage
    : type === "finish"
      ? chunk.usage ?? chunk.totalUsage
      : undefined, chunk, fallbackMetadataSource, run)
}

async function usageFromResult(result: unknown, run?: Partial<AgentRunMetadata>): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(result)) return
  return usageRecordFromUsage(await resolveUsageValue(result.usage ?? result.totalUsage), result, undefined, run)
}

export async function resolveAgentUsageRecord(value: unknown, run?: Partial<AgentRunMetadata>): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(value)) return
  const usageRecord = ownValue(value, "usageRecord")
  if (isUsageRecord(usageRecord)) return withFallbackUsageMetadata(usageRecord, value, run)
  return await usageFromResult(value, run) ?? await usageFromResult(value.raw, run)
}

function optionalMessageId(messageId: string | undefined): { messageId?: string } {
  return messageId ? { messageId } : {}
}

function optionalDurationMs(durationMs: number | undefined): { durationMs?: number } {
  return durationMs === undefined ? {} : { durationMs }
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
  if (type === "data" || type.startsWith("data-")) {
    return { data: value.data, id: value.id as string | undefined, ...optionalMessageId(messageId), ...(typeof value.transient === "boolean" ? { transient: value.transient } : {}), type: type as "data" | `data-${string}` }
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
    return { ...optionalDurationMs(readNumber(value, "durationMs", "duration")), error: typeof value.error === "string" ? value.error : undefined, id, ...optionalMessageId(messageId), name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "tool-error" || type === "tool-output-error") {
    const id = String(value.toolCallId ?? value.id)
    const error = value.error instanceof Error
      ? value.error.message
      : typeof value.errorText === "string"
        ? value.errorText
        : String(value.error || "Unknown tool error")
    return { ...optionalDurationMs(readNumber(value, "durationMs", "duration")), error, id, ...optionalMessageId(messageId), name: String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool"), output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "approval-request") {
    return { id: String(value.id), input: value.input, ...optionalMessageId(messageId), name: String(value.name || "approval"), reason: typeof value.reason === "string" ? value.reason : undefined, type: "approval-request" }
  }
  if (type === "approval-decision") {
    return { approved: value.approved === true, decidedAt: value.decidedAt as Date | string | undefined, id: String(value.id), ...optionalMessageId(messageId), reason: typeof value.reason === "string" ? value.reason : undefined, type: "approval-decision" }
  }
  if (type === "error") {
    const approvalRequest = getViteHubErrorShape(value.error)?.code === "APPROVAL_REQUIRED"
      && value.error instanceof Error
      && isRecord(value.error.cause)
      ? value.error.cause
      : undefined
    const approvalId = approvalRequest?.id
    if (approvalRequest && typeof approvalId === "string") {
      const request = approvalRequest
      const capability = typeof request.capability === "string" ? request.capability : approvalId
      const reason = typeof request.reason === "string" ? request.reason : undefined
      return { id: approvalId, input: request.input, ...optionalMessageId(messageId), name: capability, reason, type: "approval-request" }
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
    if (!explicitUsageEvent) usageRecord = usageRecordFromStreamChunk(chunk, usageSource) ?? usageRecord
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

async function* streamChunksToEventsWithTextFallback(
  chunks: AsyncIterable<unknown>,
  usageSource: unknown,
  getTextIterator: () => AsyncIterator<unknown> | undefined,
  initialTextIterator?: AsyncIterator<unknown>,
): AsyncIterable<StreamEvent> {
  let hasText = false
  const terminalEvents: StreamEvent[] = []
  let textIterator = initialTextIterator
  let textIteratorClosed = false
  try {
    for await (const event of streamChunksToEvents(chunks, usageSource)) {
      if (event.type === "text-delta" && event.text) hasText = true
      if (event.type === "finish" || event.type === "usage") {
        terminalEvents.push(event)
        continue
      }
      yield event
    }
    if (!hasText) {
      textIterator ??= getTextIterator()
      if (!textIterator) {
        yield* terminalEvents
        return
      }
      for (;;) {
        const result = await textIterator.next()
        if (result.done) {
          textIteratorClosed = true
          break
        }
        const text = result.value
        if (typeof text === "string" && text) {
          yield { text, type: "text-delta" }
        }
      }
    }
  }
  finally {
    if (textIterator && !textIteratorClosed) {
      await textIterator.return?.()
    }
  }
  yield* terminalEvents
}

function hasPropertyGetter(value: object, key: PropertyKey): boolean {
  let current: object | null = value
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return typeof descriptor.get === "function"
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
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
  const textStreamIsLazy = !!result && hasPropertyGetter(result, "textStream")
  let textStreamRead = !textStreamIsLazy
  let textStreamCandidate = textStreamRead ? result?.textStream : undefined
  const getTextStream = () => {
    if (!textStreamRead) {
      textStreamCandidate = result?.textStream
      textStreamRead = true
    }
    return isAsyncIterable(textStreamCandidate) ? textStreamCandidate : undefined
  }
  let textIterator: AsyncIterator<unknown> | undefined
  const getTextIterator = () => (textIterator ??= getTextStream()?.[Symbol.asyncIterator]())
  if (isAsyncIterable(result?.stream)) {
    const initialTextIterator = textStreamIsLazy ? undefined : getTextIterator()
    yield* streamChunksToEventsWithTextFallback(result.stream, result, getTextIterator, initialTextIterator)
    return
  }
  const fullStream = result?.fullStream
  if (isAsyncIterable(fullStream)) {
    const initialTextIterator = textStreamIsLazy ? undefined : getTextIterator()
    yield* streamChunksToEventsWithTextFallback(fullStream, result, getTextIterator, initialTextIterator)
    return
  }
  const textStream = getTextStream()
  if (textStream) {
    for await (const text of textStream) {
      if (typeof text === "string" && text) {
        yield { text, type: "text-delta" }
      }
    }
    const usageRecord = await resolveAgentUsageRecord(value)
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
    const usageRecord = await resolveAgentUsageRecord(value)
    if (usageRecord) {
      yield { type: "usage", usageRecord }
    }
    const reason = typeof (value as { finishReason?: unknown }).finishReason === "string"
      ? (value as { finishReason: string }).finishReason
      : undefined
    yield { ...(reason ? { reason } : {}), type: "finish" }
  }
}
