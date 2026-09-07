import { agentDiagnostics } from "../agent-diagnostics.ts"
import type {
  AgentRunMetadata,
  AgentUsage,
  AgentUsageCost,
  AgentUsageRecord,
  MaybePromise,
} from "../types.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

export interface AgentUsagePricingContext {
  model?: AgentUsageRecord["model"]
  provider?: AgentUsageRecord["provider"]
  response?: AgentUsageRecord["response"]
  run?: Partial<AgentRunMetadata>
  transport?: AgentUsageRecord["transport"]
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
  tiers?: Array<StaticModelPrice & { size: number }>
}

export interface ModelsDevPricingOptions {
  catalogUrl?: string
  maxAge?: number
  fetch?: typeof fetch
  timeout?: number
}

const modelsDevCatalogUrl = "https://models.dev/api.json"
const modelsDevPricingMaxAge = 60 * 60_000
const modelsDevPricingTimeout = 10_000

function decimalToParts(value: string): { scale: bigint, units: bigint } {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw agentDiagnostics.AGENT_R0591({ message: `[vitehub] Invalid decimal price "${value}".` })
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

export function aggregateAgentUsageCosts(costs: AgentUsageCost[]): AgentUsageCost | undefined {
  if (!costs.length) return
  const source = costs.every(cost => cost.source === costs[0]!.source) ? costs[0]!.source : "custom"
  return materializeAgentUsageCost({
    estimated: costs.some(cost => cost.estimated),
    source,
    usd: addDecimalParts(costs.map(cost => decimalToParts(cost.usd))),
  })
}

export async function enrichAgentUsageCost(
  record: AgentUsageRecord,
  pricing: AgentUsagePricing,
  run?: Partial<AgentRunMetadata>,
): Promise<AgentUsageRecord> {
  const calls = record.calls ? await Promise.all(record.calls.map(call => enrichAgentUsageCost(call, pricing, run))) : undefined
  let cost = record.cost
  if (!cost && calls?.length && calls.every(call => call.cost)) {
    cost = aggregateAgentUsageCosts(calls.map(call => call.cost!))
  }
  if (!cost && !calls?.length && record.usage) {
    const priced = await pricing({
      model: record.model,
      provider: record.provider,
      response: record.response,
      run: record.run || run,
      transport: record.transport,
      usage: record.usage,
    })
    cost = priced ? materializeAgentUsageCost(priced) : undefined
  }
  return {
    ...record,
    ...(calls ? { calls } : {}),
    ...(cost ? { cost: materializeAgentUsageCost(cost) } : {}),
  }
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
    [price.inputCacheRead ?? price.input, cacheReadTokens],
    [price.inputCacheWrite ?? price.input, cacheWriteTokens],
    [price.output, usage.outputTokens],
  ] as const
  if (categories.some(([value, count]) => count > 0 && value === undefined)) return
  return addDecimalParts(categories
    .map(([value, count]) => multiplyDecimal(value, count))
    .filter((item): item is { scale: bigint, units: bigint } => Boolean(item)))
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

function normalizeModelsDevPrice(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "number") || !Number.isFinite(value) || value < 0) return
  const parts = decimalToParts(decimalStringFromNumber(value))
  return addDecimalParts([{
    scale: parts.scale * 1_000_000n,
    units: parts.units,
  }])
}

function normalizeModelsDevTier(value: unknown): NonNullable<StaticModelPrice["tiers"]>[number] | undefined {
  if (!isRuntimeRecord(value)) return
  const tier = value
  const condition = tier.tier
  if (!isRuntimeRecord(condition)) return
  const conditionRecord = condition
  if (conditionRecord.type !== "context") return
  const size = conditionRecord.size
  if (!hasRuntimeType(size, "number") || !Number.isFinite(size) || size < 0) return
  return {
    input: normalizeModelsDevPrice(tier.input),
    inputCacheRead: normalizeModelsDevPrice(tier.cache_read),
    inputCacheWrite: normalizeModelsDevPrice(tier.cache_write),
    output: normalizeModelsDevPrice(tier.output),
    size,
  }
}

function normalizeModelsDevModel(value: unknown): StaticModelPrice | undefined {
  if (!isRuntimeRecord(value)) return
  const cost = value.cost
  if (!isRuntimeRecord(cost)) return
  const record = cost
  return {
    input: normalizeModelsDevPrice(record.input),
    inputCacheRead: normalizeModelsDevPrice(record.cache_read),
    inputCacheWrite: normalizeModelsDevPrice(record.cache_write),
    output: normalizeModelsDevPrice(record.output),
    tiers: Array.isArray(record.tiers)
      ? record.tiers.map(normalizeModelsDevTier).filter((tier): tier is NonNullable<ReturnType<typeof normalizeModelsDevTier>> => Boolean(tier))
      : undefined,
  }
}

function modelsDevModelCandidates(provider: string, model: string): string[] {
  const candidates = [model]
  const prefix = `${provider}/`
  if (model.startsWith(prefix)) candidates.unshift(model.slice(prefix.length))
  if (model.includes("/")) candidates.push(model.slice(model.lastIndexOf("/") + 1))
  return [...new Set(candidates)]
}

function priceForUsage(price: StaticModelPrice, usage: AgentUsage): StaticModelPrice {
  const tier = price.tiers
    ?.filter(item => usage.inputTokens !== undefined && usage.inputTokens >= item.size)
    .sort((left, right) => right.size - left.size)[0]
  return tier
    ? {
        input: tier.input ?? price.input,
        inputCacheRead: tier.inputCacheRead ?? price.inputCacheRead,
        inputCacheWrite: tier.inputCacheWrite ?? price.inputCacheWrite,
        output: tier.output ?? price.output,
      }
    : price
}

export function modelsDevPricing(options: ModelsDevPricingOptions = {}): AgentUsagePricing {
  const fetcher = options.fetch || globalThis.fetch
  const catalogUrl = options.catalogUrl || modelsDevCatalogUrl
  const maxAge = options.maxAge ?? modelsDevPricingMaxAge
  const timeout = options.timeout ?? modelsDevPricingTimeout
  let catalog: Promise<Record<string, Record<string, StaticModelPrice>>> | undefined
  let catalogExpiresAt = 0

  async function loadCatalog() {
    if (!catalog || (catalogExpiresAt > 0 && Date.now() >= catalogExpiresAt)) {
      catalogExpiresAt = 0
      catalog = (async () => {
        const response = await fetcher(catalogUrl, { signal: AbortSignal.timeout(timeout) })
        if (!response.ok) throw agentDiagnostics.AGENT_R0903({ message: `[vitehub] Models.dev pricing request failed with ${response.status}.` })
        const body: unknown = await response.json()
        if (!isRuntimeRecord(body)) throw agentDiagnostics.AGENT_R0904({ message: "[vitehub] Models.dev pricing response must be an object." })
        const result: Record<string, Record<string, StaticModelPrice>> = {}
        for (const [providerId, provider] of Object.entries(body)) {
          if (!isRuntimeRecord(provider) || !isRuntimeRecord(provider.models)) continue
          const models: Record<string, StaticModelPrice> = {}
          for (const [modelId, model] of Object.entries(provider.models)) {
            const price = normalizeModelsDevModel(model)
            if (price) models[modelId] = price
          }
          result[providerId] = models
        }
        catalogExpiresAt = Date.now() + maxAge
        return result
      })().catch((error) => {
        catalog = undefined
        catalogExpiresAt = 0
        throw error
      })
    }
    return await catalog
  }

  return async ({ model, provider, transport, usage }) => {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return
    const modelId = hasRuntimeType(model, "string") ? model.trim() : ""
    if (!modelId) return
    const providerId = hasRuntimeType(provider, "string") && provider.trim()
      ? provider.trim()
      : transport === "gateway"
        ? "vercel"
        : modelId.includes("/")
          ? modelId.slice(0, modelId.indexOf("/"))
          : ""
    if (!providerId) return
    const prices = await loadCatalog()
    const providerPrices = prices[providerId]
    if (!providerPrices) return
    const price = modelsDevModelCandidates(providerId, modelId)
      .map(candidate => providerPrices[candidate])
      .find((item): item is StaticModelPrice => Boolean(item))
    if (!price) return
    const amount = pricedTokens(usage, priceForUsage(price, usage))
    if (amount === undefined) return
    return materializeAgentUsageCost({
      estimated: true,
      source: "models.dev",
      usd: amount,
    })
  }
}
