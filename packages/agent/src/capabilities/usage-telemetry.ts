import { readAgentUsageMetadata } from "../internal/agent-usage-metadata.ts"
import { defineCapability } from "../capability-runtime.ts"
import {
  cloneWithPropertyDescriptors,
  isAsyncIterable,
  teeingAsyncIterableStreamDescriptor,
} from "../internal/stream-result.ts"

import type {
  AgentCapabilityDefinition,
  AgentFinishEvent,
  AgentOutputExtensionEvent,
  AgentRunMetadata,
  AgentUsage,
  AgentUsageCost,
  AgentUsageRecord,
  MaybePromise,
} from "../types.ts"

export interface AgentUsagePricingContext {
  model?: AgentUsageRecord["model"]
  response?: AgentUsageRecord["response"]
  run?: Partial<AgentRunMetadata>
  usage: AgentUsage
}

export type AgentUsagePricing = (context: AgentUsagePricingContext) => MaybePromise<AgentUsageCost | undefined>

export interface UsageTelemetryContext {
  run?: Partial<AgentRunMetadata>
}

export type UsageTelemetryCallback = (
  record: AgentUsageRecord,
  context: UsageTelemetryContext,
) => MaybePromise<void>

export interface UsageTelemetryOptions {
  includeRaw?: boolean
  onUsage?: UsageTelemetryCallback
  pricing?: AgentUsagePricing
  summary?: boolean | UsageTelemetrySummaryOptions
}

export interface UsageTelemetrySummaryOptions {
  format?: UsageTelemetrySummaryFormatter
  subject?: string
}

export interface UsageTelemetryOutputExtension {
  summary?: string
  usageRecord: AgentUsageRecord
}

export interface UsageTelemetrySummaryFormatContext {
  subject: string
}

export type UsageTelemetrySummaryFormatter = (
  record: AgentUsageRecord,
  context: UsageTelemetrySummaryFormatContext,
) => MaybePromise<string | null | undefined>

export interface StaticModelPrice {
  currency?: string
  input?: string
  inputCacheRead?: string
  inputCacheWrite?: string
  output?: string
  source?: AgentUsageCost["source"]
}

export interface VercelAiGatewayPricingOptions {
  fetch?: typeof fetch
  modelsUrl?: string
}

type UnknownRecord = Record<string, unknown>

interface UsageTelemetryCapabilityMetadata {
  kind: "usage-telemetry"
  usageTelemetry: UsageTelemetryOptions
}

const usageTelemetryWrapped = Symbol("vitehub.usageTelemetryWrapped")

const vercelAiGatewayModelsUrl = "https://ai-gateway.vercel.sh/v1/models"

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null
}

function readNumber(record: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
}

function readString(record: UnknownRecord, ...keys: string[]): string | undefined {
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

function hasTokenUsage(usage: AgentUsage): boolean {
  return usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.totalTokens !== undefined
    || usage.inputTokenDetails !== undefined
    || usage.outputTokenDetails !== undefined
}

export function normalizeAgentUsage(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return

  const inputTokens = readNumber(value, "inputTokens", "promptTokens", "input_tokens", "prompt_tokens")
  const outputTokens = readNumber(value, "outputTokens", "completionTokens", "output_tokens", "completion_tokens")
  const totalTokens = readNumber(value, "totalTokens", "tokens", "total_tokens")
    ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const inputTokenDetails = readDetails(value.inputTokenDetails || value.input_token_details || value.promptTokenDetails || value.prompt_token_details)
  const outputTokenDetails = readDetails(value.outputTokenDetails || value.output_token_details || value.completionTokenDetails || value.completion_token_details)
  const usage: AgentUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokenDetails ? { inputTokenDetails } : {}),
    ...(outputTokenDetails ? { outputTokenDetails } : {}),
    raw: value,
  }

  if (hasTokenUsage(usage)) return usage

  return Object.keys(value).length
    ? { details: value, raw: value }
    : undefined
}

async function usageFromResult(result: UnknownRecord, fallback?: unknown): Promise<AgentUsage | undefined> {
  const usage = normalizeAgentUsage(await resolveUsageValue(result.totalUsage ?? result.usage))
  if (usage) return usage
  if (!isRecord(fallback)) return
  return normalizeAgentUsage(await resolveUsageValue(fallback.totalUsage ?? fallback.usage))
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

function responseFromResult(result: UnknownRecord): AgentUsageRecord["response"] | undefined {
  const response = isRecord(result.response) ? result.response : undefined
  const id = response ? readString(response, "id") : undefined
  const timestamp = response?.timestamp
  const finishReason = result.finishReason
  if (id === undefined && timestamp === undefined && finishReason === undefined) return
  return {
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(id !== undefined ? { id } : {}),
    ...((timestamp instanceof Date || typeof timestamp === "string") ? { timestamp } : {}),
  }
}

function modelFromResult(result: UnknownRecord): AgentUsageRecord["model"] | undefined {
  const response = isRecord(result.response) ? result.response : undefined
  const id = response ? readString(response, "modelId", "model") : readString(result, "modelId", "model")
  const provider = readString(result, "provider")
  if (id === undefined && provider === undefined) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(provider !== undefined ? { provider } : {}),
  }
}

function latencyFromResult(result: UnknownRecord, usage: AgentUsage): AgentUsageRecord["latency"] | undefined {
  const durationMs = readNumber(result, "durationMs")
  const timeToFirstTokenMs = readNumber(result, "timeToFirstTokenMs", "ttftMs")
  const tokensPerSecond = readNumber(result, "tokensPerSecond")
    ?? (durationMs && usage.outputTokens !== undefined ? usage.outputTokens / (durationMs / 1000) : undefined)
  if (durationMs === undefined && timeToFirstTokenMs === undefined && tokensPerSecond === undefined) return
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  }
}

export async function createAgentUsageRecord(
  result: unknown,
  options: UsageTelemetryOptions = {},
  run?: Partial<AgentRunMetadata>,
  metadataSource?: unknown,
): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(result)) return
  const usage = await usageFromResult(result, metadataSource)
  if (!usage) return
  const model = modelFromResult(result)
  const response = responseFromResult(result)
  const credentialSource = credentialSourceFromMetadata(readAgentUsageMetadata(result, metadataSource))

  const record: AgentUsageRecord = {
    ...(credentialSource ? { credentialSource } : {}),
    ...(model ? { model } : {}),
    ...(response ? { response } : {}),
    ...(run ? { run } : {}),
    usage: options.includeRaw ? usage : removeRawUsage(usage),
    ...(options.includeRaw ? { raw: result } : {}),
  }
  const latency = latencyFromResult(result, usage)
  if (latency) record.latency = latency

  try {
    const cost = await options.pricing?.({
      model: record.model,
      response: record.response,
      run,
      usage,
    })
    if (cost) record.cost = cost
  }
  catch {
    // Pricing enriches telemetry; it must not fail the agent invocation.
  }

  return record
}

function removeRawUsage(usage: AgentUsage): AgentUsage {
  const { raw: _raw, ...rest } = usage
  return rest
}

function finiteUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatUsageTokens(usage: AgentUsageRecord["usage"]): string | undefined {
  const input = finiteUsageNumber(usage?.inputTokens)
  const output = finiteUsageNumber(usage?.outputTokens)
  const total = finiteUsageNumber(usage?.totalTokens) ?? (input !== undefined && output !== undefined ? input + output : undefined)
  if (total === undefined) {
    if (input !== undefined) return `${formatUsageNumber(input)} input tokens`
    if (output !== undefined) return `${formatUsageNumber(output)} output tokens`
    return
  }
  const totalText = `${formatUsageNumber(total)} tokens`
  if (input === undefined && output === undefined) return totalText
  const splitInput = input ?? (output !== undefined && total >= output ? total - output : undefined)
  const splitOutput = output ?? (input !== undefined && total >= input ? total - input : undefined)
  if (splitInput === undefined || splitOutput === undefined) return totalText
  return `${totalText}: ${formatUsageNumber(splitInput)} in / ${formatUsageNumber(splitOutput)} out`
}

function formatUsageCost(cost: AgentUsageRecord["cost"]): string | undefined {
  if (!cost?.amount) return
  const amount = cost.amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
  return cost.currency === "USD" ? `$${amount}` : `${amount} ${cost.currency}`
}

function formatUsageDuration(durationMs: unknown): string | undefined {
  const finite = finiteUsageNumber(durationMs)
  if (finite === undefined) return
  return `${(finite / 1000).toFixed(1)}s`
}

function normalizeUsageSummaryOptions(summary: UsageTelemetryOptions["summary"]): UsageTelemetrySummaryOptions | undefined {
  if (!summary) return
  return typeof summary === "object" && summary !== null ? summary : {}
}

async function formatUsageSummary(record: AgentUsageRecord, options: UsageTelemetrySummaryOptions = {}): Promise<string | undefined> {
  const subject = typeof options.subject === "string" && options.subject.trim() ? options.subject.trim() : "This invocation"
  if (options.format) {
    const summary = await options.format(record, { subject })
    return summary || undefined
  }
  const cost = formatUsageCost(record.cost)
  const tokens = formatUsageTokens(record.usage)
  const model = record.model?.id
  const duration = formatUsageDuration(record.latency?.durationMs)
  const run = [model ? `using ${model}` : undefined, duration ? `in ${duration}` : undefined].filter(Boolean).join(" ")
  if (cost) return `${subject} cost ${record.cost?.estimated ? "about " : ""}${cost}${run ? ` ${run}` : ""}${tokens ? ` (${tokens})` : ""}.`
  if (tokens) return `${subject} used ${tokens}${run ? ` ${run}` : ""}.`
  if (run) return `${subject} ran ${run}.`
}

async function usageRecordForFinish(
  record: unknown,
  event: AgentFinishEvent,
  options: UsageTelemetryOptions,
): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(record)) return
  const usageRecord = record as AgentUsageRecord
  const summaryOptions = normalizeUsageSummaryOptions(options.summary)
  if (!summaryOptions) return usageRecord
  const durationMs = finiteUsageNumber(usageRecord.latency?.durationMs) ?? finiteUsageNumber(event.invocation.durationMs)
  const withDuration = durationMs === undefined
    ? usageRecord
    : {
        ...usageRecord,
        latency: {
          ...(isRecord(usageRecord.latency) ? usageRecord.latency : {}),
          durationMs,
        },
      }
  const summary = await formatUsageSummary(withDuration, summaryOptions)
  return summary ? { ...withDuration, summary } : withDuration
}

async function usageRecordForOutput(
  record: AgentUsageRecord,
  options: UsageTelemetryOptions,
): Promise<UsageTelemetryOutputExtension> {
  const summaryOptions = normalizeUsageSummaryOptions(options.summary)
  if (!summaryOptions) return { usageRecord: record }
  const summary = await formatUsageSummary(record, summaryOptions)
  return {
    ...(summary ? { summary } : {}),
    usageRecord: record,
  }
}

async function recordUsage(
  result: UnknownRecord,
  options: UsageTelemetryOptions,
  run?: Partial<AgentRunMetadata>,
  metadataSource?: unknown,
): Promise<AgentUsageRecord | undefined> {
  const usageRecord = await createAgentUsageRecord(result, options, run, metadataSource)
  if (usageRecord) await options.onUsage?.(usageRecord, run ? { run } : {})
  return usageRecord
}

async function* withUsageTelemetryStream(
  stream: AsyncIterable<unknown>,
  options: UsageTelemetryOptions,
  run?: Partial<AgentRunMetadata>,
  onRecord?: (record: AgentUsageRecord) => void,
  metadataSource?: unknown,
): AsyncIterable<unknown> {
  let fallbackResult: UnknownRecord | undefined
  let recorded = false
  for await (const chunk of stream) {
    if (isRecord(chunk) && chunk.type === "finish") {
      const usageRecord = await recordUsage(chunk, options, run)
      if (usageRecord) {
        recorded = true
        onRecord?.(usageRecord)
        yield { type: "usage", usageRecord }
      }
      else if (isRecord(metadataSource)) {
        fallbackResult = chunk
      }
    }
    yield chunk
  }
  if (!recorded && fallbackResult) {
    const usageRecord = await recordUsage(fallbackResult, options, run, metadataSource)
    if (usageRecord) {
      onRecord?.(usageRecord)
      yield { type: "usage", usageRecord }
    }
  }
}

function defineUsageTelemetryOutput(output: UnknownRecord, usageRecord: AgentUsageRecord) {
  Object.defineProperties(output, {
    usage: {
      configurable: true,
      enumerable: true,
      value: usageRecord.usage,
      writable: true,
    },
    usageRecord: {
      configurable: true,
      enumerable: true,
      value: usageRecord,
      writable: true,
    },
  })
}

function hasUsageTelemetryStream(result: UnknownRecord): boolean {
  return isAsyncIterable(result.fullStream) || isAsyncIterable(result.stream)
}

function cloneWithUsageTelemetryStream<T extends UnknownRecord>(
  result: T,
  options: UsageTelemetryOptions,
  run?: Partial<AgentRunMetadata>,
): T {
  if ((result as UnknownRecord & { [usageTelemetryWrapped]?: boolean })[usageTelemetryWrapped]) return result
  if (!hasUsageTelemetryStream(result)) return result

  let clone = undefined as unknown as T
  const withTelemetry = (stream: AsyncIterable<unknown>) =>
    teeingAsyncIterableStreamDescriptor(withUsageTelemetryStream(stream, options, run, (usageRecord) => {
      defineUsageTelemetryOutput(clone as UnknownRecord, usageRecord)
    }, result))
  const fullStreamDescriptor = isAsyncIterable(result.fullStream) ? withTelemetry(result.fullStream) : undefined
  const descriptors: PropertyDescriptorMap = {
    ...(fullStreamDescriptor ? { fullStream: fullStreamDescriptor } : {}),
    ...(isAsyncIterable(result.stream)
      ? { stream: result.stream === result.fullStream && fullStreamDescriptor ? fullStreamDescriptor : withTelemetry(result.stream) }
      : {}),
  }
  const toUIMessageStream = result.toUIMessageStream
  if (typeof toUIMessageStream === "function") {
    descriptors.toUIMessageStream = {
      configurable: true,
      enumerable: true,
      value: (...args: unknown[]) => toUIMessageStream.apply(clone, args),
    }
  }
  clone = cloneWithPropertyDescriptors(result, descriptors)
  Object.defineProperty(clone, usageTelemetryWrapped, {
    value: true,
  })
  return clone
}

export function usageTelemetry(options: UsageTelemetryOptions = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: "usage-telemetry",
    metadata: {
      kind: "usage-telemetry",
      usageTelemetry: options,
    } satisfies UsageTelemetryCapabilityMetadata,
    output(context) {
      context.finish.provide((event: AgentFinishEvent) => usageRecordForFinish(isRecord(event.result)
        ? event.result.usageRecord
        : undefined, event, options))
      context.output.provide(async (event: AgentOutputExtensionEvent) => {
        if (!isRecord(event.result) || hasUsageTelemetryStream(event.result)) return
        const usageRecord = isRecord(event.result.usageRecord)
          ? event.result.usageRecord as AgentUsageRecord
          : await recordUsage(event.result, options, context.run)
        return usageRecord ? await usageRecordForOutput(usageRecord, options) : undefined
      })
      context.output.render(async (result, renderContext) => {
        if (isAsyncIterable(result)) return withUsageTelemetryStream(result, options, context.run)
        if (!isRecord(result)) return result
        if (hasUsageTelemetryStream(result)) return cloneWithUsageTelemetryStream(result, options, context.run)
        const usageRecord = renderContext.output.extensions.get<UsageTelemetryOutputExtension>("usage-telemetry")?.usageRecord
        if (!usageRecord) return result
        return {
          ...result,
          usage: usageRecord.usage,
          usageRecord,
        }
      })
    },
  })
}

function decimalToParts(value: string): { scale: bigint, units: bigint } {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`[vitehub] Invalid decimal price "${value}".`)
  }
  const [whole, fraction = ""] = trimmed.split(".")
  return {
    scale: 10n ** BigInt(fraction.length),
    units: BigInt(`${whole}${fraction}`),
  }
}

function addDecimalParts(items: Array<{ scale: bigint, units: bigint }>): string {
  if (!items.length) return "0"
  const scale = items.reduce((max, item) => item.scale > max ? item.scale : max, 1n)
  const units = items.reduce((total, item) => total + item.units * (scale / item.scale), 0n)
  const whole = units / scale
  const fraction = (units % scale).toString().padStart(scale.toString().length - 1, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function multiplyDecimal(value: string | undefined, count: number | undefined): { scale: bigint, units: bigint } | undefined {
  if (value === undefined || count === undefined || count <= 0) return
  const parts = decimalToParts(value)
  return {
    scale: parts.scale,
    units: parts.units * BigInt(Math.trunc(count)),
  }
}

function pricedTokens(usage: AgentUsage, price: StaticModelPrice): string {
  const inputDetails = usage.inputTokenDetails || {}
  const cacheReadTokens = inputDetails.cacheReadTokens || inputDetails.cachedTokens || 0
  const cacheWriteTokens = inputDetails.cacheWriteTokens || 0
  const regularInputTokens = Math.max(0, (usage.inputTokens || 0) - cacheReadTokens - cacheWriteTokens)
  return addDecimalParts([
    multiplyDecimal(price.input, regularInputTokens),
    multiplyDecimal(price.inputCacheRead || price.input, cacheReadTokens),
    multiplyDecimal(price.inputCacheWrite || price.input, cacheWriteTokens),
    multiplyDecimal(price.output, usage.outputTokens),
  ].filter((item): item is { scale: bigint, units: bigint } => Boolean(item)))
}

export function staticModelPricing(prices: Record<string, StaticModelPrice>): AgentUsagePricing {
  return ({ model, usage }) => {
    if (!hasTokenUsage(usage)) return
    const modelId = model?.id
    if (!modelId) return
    const price = prices[modelId]
    if (!price) return
    return {
      amount: pricedTokens(usage, price),
      currency: price.currency || "USD",
      estimated: price.source !== "provider",
      source: price.source || "custom",
    }
  }
}

function normalizeVercelPrice(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function vercelAiGatewayPricing(options: VercelAiGatewayPricingOptions = {}): AgentUsagePricing {
  const fetcher = options.fetch || globalThis.fetch
  const modelsUrl = options.modelsUrl || vercelAiGatewayModelsUrl
  let prices: Promise<Record<string, StaticModelPrice>> | undefined

  async function loadPrices() {
    prices ??= (async () => {
      const response = await fetcher(modelsUrl)
      if (!response.ok) throw new Error(`[vitehub] Vercel AI Gateway pricing request failed with ${response.status}.`)
      const body = await response.json() as { data?: Array<{ id?: unknown, pricing?: UnknownRecord }> }
      const result: Record<string, StaticModelPrice> = {}
      for (const model of body.data || []) {
        if (typeof model.id !== "string" || !model.pricing) continue
        result[model.id] = {
          input: normalizeVercelPrice(model.pricing.input),
          inputCacheRead: normalizeVercelPrice(model.pricing.input_cache_read),
          inputCacheWrite: normalizeVercelPrice(model.pricing.input_cache_write),
          output: normalizeVercelPrice(model.pricing.output),
          source: "vercel-ai-gateway",
        }
      }
      return result
    })()
    return await prices
  }

  return async ({ model, usage }) => {
    if (!hasTokenUsage(usage)) return
    const modelId = model?.id
    if (!modelId) return
    const price = (await loadPrices())[modelId]
    if (!price) return
    return {
      amount: pricedTokens(usage, price),
      currency: price.currency || "USD",
      estimated: true,
      source: "vercel-ai-gateway",
    }
  }
}
