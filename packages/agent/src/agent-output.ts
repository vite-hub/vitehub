import { hasRuntimeType, isRuntimeObject, runtimeType } from "./internal/runtime-type.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { publishedDeliveryArtifactsFromUnknown } from "./delivery-artifacts.ts"
import { readAgentUsageMetadata } from "./internal/agent-usage-metadata.ts"
import { isAsyncIterable } from "./internal/stream-result.ts"
import { finalChannelOutputSelectedSymbol } from "./internal/final-channel-output.ts"
import { synthesizedAgentOutputSymbol } from "./internal/synthesized-agent-output.ts"
import { materializeAgentUsageCost } from "./internal/usage-pricing.ts"

import type { AgentActivity, AgentMessagePhase, StreamEvent } from "./messages.ts"
import type { AgentRunMetadata, AgentRunResult, AgentUsage, AgentUsageRecord } from "./types.ts"

export { isAsyncIterable } from "./internal/stream-result.ts"

export function agentResultKind(result: unknown): string {
  if (result === null) return "null"
  if (isAsyncIterable(result)) return "stream"
  if (Array.isArray(result)) return "array"
  return runtimeType(result)
}

export function hasTraceableStreamResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return ["fullStream", "stream", "textStream"].some((property) => {
    let descriptor: PropertyDescriptor | undefined
    for (let owner: object | null = value; owner && !descriptor; owner = Object.getPrototypeOf(owner))
      descriptor = Object.getOwnPropertyDescriptor(owner, property)
    return descriptor !== undefined
      && ("get" in descriptor || isAsyncIterable(descriptor.value))
  })
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return

  const text = content.flatMap((part) => {
    if (hasRuntimeType(part, "string")) return [part]
    if (!part || !hasRuntimeType(part, "object")) return []

    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    const record = part as Record<string, unknown>
    const type = ownValue(record, "type")
    if (type !== "text" && type !== "text-delta") return []

    const value = ownValue(record, "text") ?? ownValue(record, "textDelta") ?? ownValue(record, "delta")
    return hasRuntimeType(value, "string") ? [value] : []
  }).join("")

  return text ? text : undefined
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function textFromResult(result: Record<string, unknown>): string | undefined {
  const text = ownValue(result, "text")
  if (hasRuntimeType(text, "string") && text) return text
  const output = ownValue(result, "output")
  if (hasRuntimeType(output, "string") && output) return output
  const rawOutput = ownValue(result, "_output")
  if (hasRuntimeType(rawOutput, "string") && rawOutput) return rawOutput
  const contentText = textFromContent(ownValue(result, "content"))
  if (contentText) return contentText

  const steps = ownValue(result, "steps")
  if (Array.isArray(steps)) {
    for (const step of steps.slice().reverse()) {
      if (step && hasRuntimeType(step, "object")) {
        // SAFETY: Agent output normalization establishes the asserted stream result contract.
        const record = step as Record<string, unknown>
        const stepText = ownValue(record, "text")
        if (hasRuntimeType(stepText, "string") && stepText) return stepText
        const stepContentText = textFromContent(ownValue(record, "content"))
        if (stepContentText) return stepContentText
      }
    }
  }
}

function finalTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return

  const boundary = content.findLastIndex((part) => {
    if (!part || !hasRuntimeType(part, "object")) return false
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    const type = ownValue(part as Record<string, unknown>, "type")
    return hasRuntimeType(type, "string") && type.startsWith("tool-")
  })
  return boundary >= 0 ? textFromContent(content.slice(boundary + 1)) ?? "" : undefined
}

function contentFromSteps(steps: unknown[]): unknown[] {
  return steps.flatMap((step) => {
    if (!isRecord(step)) return []
    const content = ownValue(step, "content")
    const text = ownValue(step, "text")
    if (!Array.isArray(content)) return hasRuntimeType(text, "string") && text ? [{ text, type: "text" }] : []
    return hasRuntimeType(text, "string") && text && textFromContent(content) === undefined
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
  if (hasRuntimeType(value, "string")) return value
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
  if (!hasRuntimeType(value, "object") || value === null) {
    return { raw: value, text: hasRuntimeType(value, "string") ? value : undefined }
  }

  // SAFETY: Agent output normalization establishes the asserted stream result contract.
  const result = value as Record<string, unknown>
  const explicitText = ownValue(result, "text")
  const selectedChannelOutput = Object.getOwnPropertyDescriptor(result, finalChannelOutputSelectedSymbol)?.value === true
  const raw = selectedChannelOutput ? ownValue(result, "raw") : value
  const normalized = selectedChannelOutput && isRecord(raw) ? raw : result
  const selectedValue = (key: string) => ownValue(result, key) ?? ownValue(normalized, key)
  const usageRecord = isUsageRecord(selectedValue("usageRecord"))
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    ? withFallbackUsageMetadata(withFallbackUsageMetadata(selectedValue("usageRecord") as AgentUsageRecord, result), normalized)
    : usageRecordFromUsage(selectedValue("usage") ?? selectedValue("totalUsage"), result, normalized)
  const artifacts = publishedDeliveryArtifactsFromUnknown(selectedValue("artifacts"))
  return {
    ...(artifacts.length ? { artifacts } : {}),
    finishReason: selectedValue("finishReason"),
    raw,
    text: selectedChannelOutput && hasRuntimeType(explicitText, "string") ? explicitText : textFromResult(result),
    usage: selectedValue("usage") ?? usageRecord?.usage,
    usageRecord,
    warnings: selectedValue("warnings"),
  }
}

function isUsageRecord(value: unknown): value is AgentUsageRecord {
  if (!isRecord(value)) return false
  return ["calls", "cost", "credentialSource", "latency", "model", "raw", "response", "run", "transport", "usage"].some(key => key in value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return hasRuntimeType(value, "object") && value !== null
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (hasRuntimeType(value, "number") && Number.isFinite(value)) return value
  }
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return
  for (const key of keys) {
    const value = record[key]
    if (hasRuntimeType(value, "string") && value) return value
  }
}

function readDetails(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return
  const details: Record<string, number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (hasRuntimeType(item, "number") && Number.isFinite(item)) details[key] = item
  }
  return Object.keys(details).length ? details : undefined
}

function credentialSourceFromMetadata(metadata: unknown): AgentUsageRecord["credentialSource"] | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.credentialSource)) return
  const source = metadata.credentialSource.source
  const label = metadata.credentialSource.label
  if (source !== undefined && !hasRuntimeType(source, "string")) return
  if (label !== undefined && !hasRuntimeType(label, "string")) return
  if (source === undefined && label === undefined) return
  return {
    ...(label ? { label } : {}),
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    ...(source ? { source: source as NonNullable<AgentUsageRecord["credentialSource"]>["source"] } : {}),
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && hasRuntimeType(value.then, "function")
}

async function resolveUsageValue(value: unknown): Promise<unknown> {
  return isPromiseLike(value) ? await value : value
}

function modelMetadataFromResult(result: unknown): Pick<AgentUsageRecord, "model" | "transport"> | undefined {
  if (!isRecord(result)) return
  const response = isRecord(result.response) ? result.response : undefined
  const rawModel = readString(response, "modelId", "model") ?? readString(result, "modelId", "model")
  const provider = readString(result, "provider")
  if (rawModel === undefined && provider !== "gateway") return
  const scope = rawModel && provider && provider !== "gateway" ? modelVendorScope(provider) : undefined
  const model = scope && rawModel && !rawModel.includes("/")
    ? `${scope}/${rawModel}`
    : rawModel
  return {
    ...(model !== undefined ? { model } : {}),
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    ...(provider === "gateway" ? { transport: "gateway" as const } : {}),
  }
}

function modelVendorScope(provider: string): string {
  const normalized = provider.toLowerCase()
  if (normalized.split(".").includes("anthropic")) return "anthropic"
  return provider.includes(".") ? provider.split(".", 1)[0]! : provider
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
    ...((timestamp instanceof Date || hasRuntimeType(timestamp, "string")) ? { timestamp } : {}),
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

function providerCostFromResult(result: unknown): AgentUsageRecord["cost"] | undefined {
  if (!isRecord(result) || !isRecord(result.providerMetadata)) return
  for (const metadata of Object.values(result.providerMetadata)) {
    const cost = isRecord(metadata) && isRecord(metadata.usage) ? metadata.usage.cost : undefined
    if (hasRuntimeType(cost, "number") && Number.isFinite(cost) && cost >= 0) {
      return materializeAgentUsageCost({
        estimated: false,
        source: "provider",
        usd: decimalStringFromNumber(Object.is(cost, -0) ? 0 : cost),
      })
    }
  }
}

function decimalStringFromNumber(value: number): string {
  const [coefficient, rawExponent] = value.toString().split("e")
  if (rawExponent === undefined) return coefficient
  const digits = coefficient.replace(".", "")
  const decimalIndex = (coefficient.indexOf(".") === -1 ? coefficient.length : coefficient.indexOf(".")) + Number(rawExponent)
  if (decimalIndex <= 0) return `0.${"0".repeat(-decimalIndex)}${digits}`
  if (decimalIndex >= digits.length) return `${digits}${"0".repeat(decimalIndex - digits.length)}`
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
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
  const modelMetadata = modelMetadataFromResult(metadataSource) ?? modelMetadataFromResult(fallbackMetadataSource)
  const response = responseFromResult(metadataSource) ?? responseFromResult(fallbackMetadataSource)
  const latency = latencyFromResult(metadataSource) ?? latencyFromResult(fallbackMetadataSource)
  const credentialSource = credentialSourceFromMetadata(readAgentUsageMetadata(metadataSource, fallbackMetadataSource))
  const cost = providerCostFromResult(metadataSource) ?? providerCostFromResult(fallbackMetadataSource)
  return {
    ...(cost ? { cost } : {}),
    ...(credentialSource ? { credentialSource } : {}),
    ...(latency ? { latency } : {}),
    ...modelMetadata,
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
  const compound = Boolean(record.calls?.length)
  const modelMetadata = modelMetadataFromResult(fallbackMetadataSource)
  const model = record.model ?? (compound ? undefined : modelMetadata?.model)
  const transport = record.transport ?? (compound ? undefined : modelMetadata?.transport)
  let cost = compound ? undefined : providerCostFromResult(fallbackMetadataSource)
  try {
    if (record.cost) cost = materializeAgentUsageCost(record.cost)
  }
  catch {
    cost = compound ? undefined : providerCostFromResult(fallbackMetadataSource)
  }
  const response = record.response ?? (compound ? undefined : responseFromResult(fallbackMetadataSource))
  const latency = record.latency ?? (compound ? undefined : latencyFromResult(fallbackMetadataSource))
  const credentialSource = record.credentialSource ?? (compound ? undefined : credentialSourceFromMetadata(readAgentUsageMetadata(record, fallbackMetadataSource)))
  const runMetadata = record.run ?? run
  return model || transport || cost || response || latency || credentialSource || runMetadata
    ? {
        ...record,
        ...(cost ? { cost } : {}),
        ...(credentialSource ? { credentialSource } : {}),
        ...(latency ? { latency } : {}),
        ...(model ? { model } : {}),
        ...(response ? { response } : {}),
        ...(runMetadata ? { run: runMetadata } : {}),
        ...(transport ? { transport } : {}),
      }
    : record
}

export function usageRecordFromStreamChunk(chunk: unknown, fallbackMetadataSource?: unknown, run?: Partial<AgentRunMetadata>): AgentUsageRecord | undefined {
  if (!isRecord(chunk)) return
  const type = String(chunk.type || "")
  if (isUsageRecord(chunk.usageRecord)) {
    return withFallbackUsageMetadata(
      withFallbackUsageMetadata(chunk.usageRecord, chunk, run),
      fallbackMetadataSource,
      run,
    )
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

function agentActivity(value: unknown): AgentActivity | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  // SAFETY: Agent output normalization establishes the asserted stream result contract.
  const activity = value as { kind?: unknown, name?: unknown }
  if (activity.kind === "tool") return { kind: "tool" }
  if (activity.kind === "action" && hasRuntimeType(activity.name, "string") && activity.name) return { kind: "action", name: activity.name }
}

function optionalAgentActivity(value: unknown): { activity?: AgentActivity } {
  const activity = agentActivity(value)
  return activity ? { activity } : {}
}

export function toAgentStreamEvent(
  chunk: unknown,
  toolNames?: Map<string, string>,
  textPhases?: Map<string, AgentMessagePhase | "hidden">,
  toolActivities?: ReadonlyMap<string, AgentActivity>,
): StreamEvent | undefined {
  if (hasRuntimeType(chunk, "string")) {
    return { text: chunk, type: "text-delta" }
  }
  if (!chunk || !hasRuntimeType(chunk, "object")) {
    return undefined
  }

  // SAFETY: Agent output normalization establishes the asserted stream result contract.
  const value = chunk as Record<string, unknown>
  const type = String(value.type || "")
  const messageId = hasRuntimeType(value.messageId, "string") ? value.messageId : undefined
  const hasExplicitPhase = "phase" in value && value.phase !== undefined
  const phase = value.phase === "commentary"
    ? "commentary"
    : value.phase === "final" || value.phase === "final_answer"
      ? "final"
      : undefined
  const textId = hasRuntimeType(value.id, "string") ? value.id : undefined
  if (type === "text-start") {
    if (textId) {
      textPhases?.delete(textId)
      if (hasExplicitPhase) textPhases?.set(textId, phase ?? "hidden")
    }
    return undefined
  }
  if (type === "text-end") {
    if (textId) textPhases?.delete(textId)
    return undefined
  }
  if (type === "text-delta" || type === "text") {
    if (textId && hasExplicitPhase) {
      textPhases?.delete(textId)
      textPhases?.set(textId, phase ?? "hidden")
    }
    if (hasExplicitPhase && !phase) return undefined
    const inheritedPhase = !hasExplicitPhase && textId ? textPhases?.get(textId) : undefined
    if (inheritedPhase === "hidden") return undefined
    const textPhase = phase ?? inheritedPhase
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    return { id: textId, ...optionalMessageId(messageId), ...(textPhase ? { phase: textPhase } : {}), ...(hasRuntimeType(value.role, "string") ? { role: value.role as never } : {}), text: String(value.text || value.textDelta || value.delta || ""), type: "text-delta" }
  }
  if (type === "data" || type.startsWith("data-")) {
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    return { data: value.data, id: value.id as string | undefined, ...optionalMessageId(messageId), ...(hasRuntimeType(value.transient, "boolean") ? { transient: value.transient } : {}), type: type as "data" | `data-${string}` }
  }
  if (type === "tool-input-start") {
    const id = String(value.id || value.toolCallId)
    const name = String(value.toolName || value.name || toolNames?.get(id) || "tool")
    toolNames?.set(id, name)
    return { ...optionalAgentActivity(value.activity ?? toolActivities?.get(name)), id, input: value.input, ...optionalMessageId(messageId), name, type: "tool-input-start" }
  }
  if (type === "tool-call" || type === "tool-input-available") {
    const id = String(value.toolCallId ?? value.id)
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    toolNames?.set(id, name)
    return { ...optionalAgentActivity(value.activity ?? toolActivities?.get(name)), id, input: value.input ?? value.args, ...optionalMessageId(messageId), name, type: "tool-call" }
  }
  if (type === "tool-result" || type === "tool-output-available") {
    const id = String(value.toolCallId ?? value.id)
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    return { ...optionalAgentActivity(value.activity ?? toolActivities?.get(name)), ...optionalDurationMs(readNumber(value, "durationMs", "duration")), error: hasRuntimeType(value.error, "string") ? value.error : undefined, id, ...optionalMessageId(messageId), name, output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "tool-error" || type === "tool-output-error") {
    const id = String(value.toolCallId ?? value.id)
    const error = value.error instanceof Error
      ? value.error.message
      : hasRuntimeType(value.errorText, "string")
        ? value.errorText
        : String(value.error || "Unknown tool error")
    const name = String(value.toolName ?? value.name ?? toolNames?.get(id) ?? "tool")
    return { ...optionalAgentActivity(value.activity ?? toolActivities?.get(name)), ...optionalDurationMs(readNumber(value, "durationMs", "duration")), error, id, ...optionalMessageId(messageId), name, output: value.output ?? value.result, type: "tool-result" }
  }
  if (type === "approval-request") {
    return { id: String(value.id), input: value.input, ...optionalMessageId(messageId), name: String(value.name || "approval"), reason: hasRuntimeType(value.reason, "string") ? value.reason : undefined, type: "approval-request" }
  }
  if (type === "tool-approval-request") {
    const id = String(value.approvalId ?? value.id)
    const toolCallId = String(value.toolCallId ?? id)
    return { id, ...optionalMessageId(messageId), name: String(value.toolName ?? toolNames?.get(toolCallId) ?? "tool"), toolCallId, type: "approval-request" }
  }
  if (type === "approval-decision") {
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    return { approved: value.approved === true, decidedAt: value.decidedAt as Date | string | undefined, id: String(value.id), ...optionalMessageId(messageId), reason: hasRuntimeType(value.reason, "string") ? value.reason : undefined, type: "approval-decision" }
  }
  if (type === "error") {
    const approvalRequest = getViteHubErrorShape(value.error)?.code === "APPROVAL_REQUIRED"
      && value.error instanceof Error
      && isRecord(value.error.cause)
      ? value.error.cause
      : undefined
    const approvalId = approvalRequest?.id
    if (approvalRequest && hasRuntimeType(approvalId, "string")) {
      const request = approvalRequest
      const capability = hasRuntimeType(request.capability, "string") ? request.capability : approvalId
      const reason = hasRuntimeType(request.reason, "string") ? request.reason : undefined
      return { id: approvalId, input: request.input, ...optionalMessageId(messageId), name: capability, reason, type: "approval-request" }
    }
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    const event = { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), ...(hasRuntimeType(value.id, "string") ? { id: value.id } : {}), ...optionalMessageId(messageId), ...(value.recoverable === true ? { recoverable: true } : {}), type: "error" as const }
    if (value.error instanceof Error) Object.defineProperty(event, agentStreamErrorSymbol, { value: value.error })
    return event
  }
  if (type === "usage" && isUsageRecord(value.usageRecord)) {
    return { ...optionalMessageId(messageId), type: "usage", usageRecord: value.usageRecord }
  }
  if (type === "finish") {
    const reason = hasRuntimeType(value.finishReason, "string") ? value.finishReason : hasRuntimeType(value.reason, "string") ? value.reason : undefined
    return { ...optionalMessageId(messageId), ...(reason ? { reason } : {}), type: "finish" }
  }
  return undefined
}

export const agentStreamErrorSymbol: unique symbol = Symbol("vitehub.agent-stream-error")

async function* streamChunksToEvents(
  chunks: AsyncIterable<unknown>,
  usageSource?: unknown,
  observation?: { explicitTextPhaseSeen: boolean },
): AsyncIterable<StreamEvent> {
  const toolNames = new Map<string, string>()
  const textPhases = new Map<string, AgentMessagePhase>()
  let usageRecord: AgentUsageRecord | undefined
  let explicitUsageEvent = false
  let finishEvent: StreamEvent | undefined
  for await (const chunk of chunks) {
    const explicitlyPhasedTextChunk = chunk && hasRuntimeType(chunk, "object")
      // SAFETY: Agent output normalization establishes the asserted stream result contract.
      && "phase" in chunk && (chunk as { phase?: unknown }).phase !== undefined
      // SAFETY: Agent output normalization establishes the asserted stream result contract.
      && "type" in chunk && ["text", "text-delta", "text-end", "text-start"].includes(String((chunk as { type?: unknown }).type))
    if (explicitlyPhasedTextChunk && observation) observation.explicitTextPhaseSeen = true
    if (!explicitUsageEvent) usageRecord = usageRecordFromStreamChunk(chunk, usageSource) ?? usageRecord
    const event = toAgentStreamEvent(chunk, toolNames, textPhases)
    if (!event) continue
    if (event.type === "text-delta" && event.phase !== undefined && observation) {
      observation.explicitTextPhaseSeen = true
    }
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
  const observation = { explicitTextPhaseSeen: false }
  const terminalEvents: StreamEvent[] = []
  let textIterator = initialTextIterator
  let textIteratorClosed = false
  try {
    for await (const event of streamChunksToEvents(chunks, usageSource, observation)) {
      if (event.type === "text-delta" && event.text) hasText = true
      if (event.type === "finish" || event.type === "usage") {
        terminalEvents.push(event)
        continue
      }
      yield event
    }
    if (!hasText && !observation.explicitTextPhaseSeen) {
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
        if (hasRuntimeType(text, "string") && text) {
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

function hasPropertyGetter(value: unknown, key: PropertyKey): boolean {
  if (!isRuntimeObject(value)) return false
  let current: object | null = value
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return hasRuntimeType(descriptor.get, "function")
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

export async function* streamAgentOutputToEvents(value: unknown): AsyncIterable<StreamEvent> {
  if (hasRuntimeType(value, "string")) {
    if (value) yield { text: value, type: "text-delta" }
    yield { type: "finish" }
    return
  }
  if (value instanceof Response) {
    if (value.body) {
      for await (const text of value.body.pipeThrough(new TextDecoderStream())) {
        if (text) yield { text, type: "text-delta" }
      }
    }
    yield { type: "finish" }
    return
  }
  const result = value && hasRuntimeType(value, "object")
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
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
      if (hasRuntimeType(text, "string") && text) {
        yield { text, type: "text-delta" }
      }
    }
    const usageRecord = await resolveAgentUsageRecord(value)
    if (usageRecord) yield { type: "usage", usageRecord }
    yield { type: "finish" }
    return
  }
  if (isAsyncIterable(value)) {
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    yield* streamChunksToEvents(value as AsyncIterable<unknown>)
    return
  }
  const text = hasRuntimeType(value, "object") && value !== null
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    ? textFromResult(value as Record<string, unknown>)
    : undefined
  if (hasRuntimeType(text, "string")) {
    if (text) yield { text, type: "text-delta" }
    const usageRecord = await resolveAgentUsageRecord(value)
    if (usageRecord) {
      yield { type: "usage", usageRecord }
    }
    // SAFETY: Agent output normalization establishes the asserted stream result contract.
    const reason = hasRuntimeType((value as { finishReason?: unknown }).finishReason, "string")
      // SAFETY: Agent output normalization establishes the asserted stream result contract.
      ? (value as { finishReason: string }).finishReason
      : undefined
    yield { ...(reason ? { reason } : {}), type: "finish" }
  }
}
