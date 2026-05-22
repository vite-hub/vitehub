import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentFinishEvent,
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

export interface UsageTelemetryOptions {
  includeRaw?: boolean
  pricing?: AgentUsagePricing
}

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

  return usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.totalTokens !== undefined
    || usage.inputTokenDetails !== undefined
    || usage.outputTokenDetails !== undefined
    ? usage
    : undefined
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
): Promise<AgentUsageRecord | undefined> {
  if (!isRecord(result)) return
  const usage = normalizeAgentUsage(result.totalUsage ?? result.usage)
  if (!usage) return
  const model = modelFromResult(result)
  const response = responseFromResult(result)

  const record: AgentUsageRecord = {
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

export function usageTelemetry(options: UsageTelemetryOptions = {}): AgentCapabilityDefinition {
  return defineCapability({
    id: "usage-telemetry",
    name: "Usage Telemetry",
    output(context) {
      context.finish.provide((event: AgentFinishEvent) => isRecord(event.result)
        ? event.result.usageRecord
        : undefined)
      context.output.render(async (result) => {
        if (!isRecord(result)) return result
        const usageRecord = await createAgentUsageRecord(result, options, context.run)
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
