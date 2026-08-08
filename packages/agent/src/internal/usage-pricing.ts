import type {
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

export type AgentUsagePrice = Omit<AgentUsageCost, "display">

export type AgentUsagePricing = (context: AgentUsagePricingContext) => MaybePromise<AgentUsagePrice | undefined>

export function materializeAgentUsageCost(cost: AgentUsageCost | AgentUsagePrice): AgentUsageCost {
  const usd = cost.usd.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
  return {
    ...cost,
    display: `${cost.estimated ? "~" : ""}$${usd}`,
  }
}

interface StaticModelPrice {
  input?: string
  inputCacheRead?: string
  inputCacheWrite?: string
  output?: string
}

export interface VercelAiGatewayPricingOptions {
  maxAge?: number
  fetch?: typeof fetch
  modelsUrl?: string
  timeout?: number
}

const vercelAiGatewayModelsUrl = "https://ai-gateway.vercel.sh/v1/models"
const vercelAiGatewayPricingMaxAge = 5 * 60_000
const vercelAiGatewayPricingTimeout = 10_000

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

function pricedTokens(usage: AgentUsage, price: StaticModelPrice): string | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return
  const inputDetails = usage.inputTokenDetails || {}
  const cacheReadTokens = inputDetails.cacheReadTokens || inputDetails.cachedTokens || 0
  const cacheWriteTokens = inputDetails.cacheWriteTokens || 0
  const regularInputTokens = Math.max(0, (usage.inputTokens || 0) - cacheReadTokens - cacheWriteTokens)
  const categories = [
    [price.input, regularInputTokens],
    [price.inputCacheRead || price.input, cacheReadTokens],
    [price.inputCacheWrite || price.input, cacheWriteTokens],
    [price.output, usage.outputTokens],
  ] as const
  if (categories.some(([value, count]) => count > 0 && value === undefined)) return
  return addDecimalParts(categories
    .map(([value, count]) => multiplyDecimal(value, count))
    .filter((item): item is { scale: bigint, units: bigint } => Boolean(item)))
}

function normalizeVercelPrice(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function addModelIdCandidate(candidates: string[], value: string | undefined) {
  if (value && !candidates.includes(value)) candidates.push(value)
}

function normalizeAnthropicGatewayModelId(id: string): string {
  return id
    .replace(/^anthropic\//, "")
    .replace(/^claude-(\d+)-(\d+)-/, "claude-$1.$2-")
    .replace(/(.+-\d+)-(\d+)$/, "$1.$2")
}

function vercelGatewayModelIdCandidates(model: AgentUsageRecord["model"] | undefined): string[] {
  const modelId = typeof model === "string" ? model.trim() : ""
  if (!modelId) return []
  const candidates: string[] = []
  addModelIdCandidate(candidates, modelId)

  const unscoped = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId
  const isAnthropic = modelId.startsWith("anthropic/") || (!modelId.includes("/") && unscoped.startsWith("claude-"))
  if (isAnthropic) {
    addModelIdCandidate(candidates, `anthropic/${unscoped}`)
    addModelIdCandidate(candidates, `anthropic/${normalizeAnthropicGatewayModelId(unscoped)}`)
  }

  return candidates
}

export function vercelAiGatewayPricing(options: VercelAiGatewayPricingOptions = {}): AgentUsagePricing {
  const fetcher = options.fetch || globalThis.fetch
  const maxAge = options.maxAge ?? vercelAiGatewayPricingMaxAge
  const modelsUrl = options.modelsUrl || vercelAiGatewayModelsUrl
  const timeout = options.timeout ?? vercelAiGatewayPricingTimeout
  let prices: Promise<Record<string, StaticModelPrice>> | undefined
  let pricesExpiresAt = 0

  async function loadPrices() {
    if (!prices || (pricesExpiresAt > 0 && Date.now() >= pricesExpiresAt)) {
      pricesExpiresAt = 0
      prices = (async () => {
        const response = await fetcher(modelsUrl, { signal: AbortSignal.timeout(timeout) })
        if (!response.ok) throw new Error(`[vitehub] Vercel AI Gateway pricing request failed with ${response.status}.`)
        const body = await response.json() as { data?: Array<{ id?: unknown, pricing?: Record<string, unknown> }> }
        const result: Record<string, StaticModelPrice> = {}
        for (const model of body.data || []) {
          if (typeof model.id !== "string" || !model.pricing) continue
          result[model.id] = {
            input: normalizeVercelPrice(model.pricing.input),
            inputCacheRead: normalizeVercelPrice(model.pricing.input_cache_read),
            inputCacheWrite: normalizeVercelPrice(model.pricing.input_cache_write),
            output: normalizeVercelPrice(model.pricing.output),
          }
        }
        pricesExpiresAt = Date.now() + maxAge
        return result
      })().catch((error) => {
        prices = undefined
        pricesExpiresAt = 0
        throw error
      })
    }
    return await prices
  }

  return async ({ model, usage }) => {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return
    const modelIds = vercelGatewayModelIdCandidates(model)
    if (!modelIds.length) return
    const catalog = await loadPrices()
    const price = modelIds
      .map(modelId => catalog[modelId])
      .find((item): item is StaticModelPrice => Boolean(item))
    if (!price) return
    const amount = pricedTokens(usage, price)
    if (amount === undefined) return
    return materializeAgentUsageCost({
      estimated: true,
      source: "vercel-ai-gateway",
      usd: amount,
    })
  }
}
