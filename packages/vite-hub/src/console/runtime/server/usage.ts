import type { AgentInvocationRecord, AgentInvocations } from "@vite-hub/agent"
import * as v from "valibot"

export interface ConsoleUsageCost {
  display: string
  estimated: boolean
  source: string
  usd: string
}

export interface ConsoleInvocationUsage {
  cacheWriteTokens?: number
  cachedInputTokens?: number
  calls?: ConsoleInvocationUsage[]
  cost?: ConsoleUsageCost
  inputTokens?: number
  model?: string
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

interface InvocationUsageProjection {
  incomplete: boolean
  usage?: ConsoleInvocationUsage
}

interface UsageWindow {
  bucket: "day" | "hour"
  durationMs: number
}

interface UsageTotal {
  cacheWriteTokensAvailable: boolean
  cacheWriteTokens: number
  cachedInputTokensAvailable: boolean
  cachedInputTokens: number
  costAvailable: boolean
  costEstimated: boolean
  cost: Decimal
  inputTokensAvailable: boolean
  inputTokens: number
  invocations: number
  outputTokensAvailable: boolean
  outputTokens: number
  reasoningTokensAvailable: boolean
  reasoningTokens: number
  totalTokensAvailable: boolean
  totalTokens: number
}

interface Decimal {
  scale: number
  units: bigint
}

interface PublicUsageTotals {
  cacheWriteTokensAvailable: boolean
  cacheWriteTokens: number
  cachedInputTokensAvailable: boolean
  cachedInputTokens: number
  costAvailable: boolean
  costEstimated: boolean
  costUsd: string
  inputTokensAvailable: boolean
  inputTokens: number
  invocationsAvailable: boolean
  invocations: number
  outputTokensAvailable: boolean
  outputTokens: number
  reasoningTokensAvailable: boolean
  reasoningTokens: number
  totalTokensAvailable: boolean
  totalTokens: number
}

export type ConsoleUsageWindow = "24h" | "7d" | "30d" | "90d"

const usageWindows: Record<ConsoleUsageWindow, UsageWindow> = {
  "24h": { bucket: "hour", durationMs: 24 * 60 * 60 * 1_000 },
  "7d": { bucket: "day", durationMs: 7 * 24 * 60 * 60 * 1_000 },
  "30d": { bucket: "day", durationMs: 30 * 24 * 60 * 60 * 1_000 },
  "90d": { bucket: "day", durationMs: 90 * 24 * 60 * 60 * 1_000 },
}

export function parseConsoleUsageWindow(value: string): ConsoleUsageWindow | undefined {
  if (value === "24h" || value === "7d" || value === "30d" || value === "90d") return value
}

const maximumUsageRecords = 10_000
const finiteNumberSchema = v.pipe(v.number(), v.check((value: number) => Number.isFinite(value)), v.minValue(0))
const stringSchema = v.string()

function object(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const result = v.safeParse(finiteNumberSchema, value)
  return result.success ? result.output : undefined
}

function detailNumber(details: unknown, ...keys: string[]): number | undefined {
  const value = object(details)
  if (!value) return
  for (const key of keys) {
    const resolved = finiteNumber(value[key])
    if (resolved !== undefined) return resolved
  }
}

function decimal(value: string | undefined): Decimal | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return
  const [whole, fraction = ""] = value.split(".")
  return {
    scale: fraction.length,
    units: BigInt(`${whole}${fraction}`),
  }
}

function stringValue(value: unknown): string | undefined {
  const result = v.safeParse(stringSchema, value)
  return result.success ? result.output : undefined
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale)
  return {
    scale,
    units: left.units * 10n ** BigInt(scale - left.scale)
      + right.units * 10n ** BigInt(scale - right.scale),
  }
}

function decimalString(value: Decimal): string {
  if (value.scale === 0) return value.units.toString()
  const scale = 10n ** BigInt(value.scale)
  const whole = value.units / scale
  const fraction = (value.units % scale)
    .toString()
    .padStart(value.scale, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function allPresent<T>(values: Array<T | undefined>): values is T[] {
  return values.every(value => value !== undefined)
}

function sumNumber(values: Array<number | undefined>): number | undefined {
  if (!values.length || !allPresent(values)) return
  return values.reduce((total, value) => total + value, 0)
}

function sumCost(values: Array<ConsoleUsageCost | undefined>): ConsoleUsageCost | undefined {
  const decimals = values.map(value => decimal(value?.usd))
  if (!decimals.length || !allPresent(decimals)) return
  const total = decimals.reduce(addDecimal, { scale: 0, units: 0n })
  const estimated = values.some(value => value?.estimated === true)
  const sources = [...new Set(values.flatMap(value => value?.source ? [value.source] : []))]
  const usd = decimalString(total)
  return {
    display: `${estimated ? "~" : ""}$${usd}`,
    estimated,
    source: sources.length === 1 ? sources[0]! : "mixed",
    usd,
  }
}

function usageNode(value: unknown, includeCalls = true, inheritedModel?: string): ConsoleInvocationUsage | undefined {
  const record = object(value)
  if (!record) return
  const usage = object(record.usage)
  const inputDetails = object(usage?.inputTokenDetails)
  const outputDetails = object(usage?.outputTokenDetails)
  const usageDetails = object(usage?.details)
  const cost = object(record.cost)
  const costUsd = stringValue(cost?.usd)
  const costValue = decimal(costUsd)
  const projectedCost: ConsoleUsageCost | undefined = costValue === undefined || costUsd === undefined
    ? undefined
    : {
        display: stringValue(cost?.display) ?? `$${costUsd}`,
        estimated: cost?.estimated === true,
        source: stringValue(cost?.source) ?? "provider",
        usd: costUsd,
      }
  const model = stringValue(record.model)?.trim() || inheritedModel
  const rawCalls = includeCalls && Array.isArray(record.calls) ? record.calls : []
  const directCalls = rawCalls.map(call => usageNode(call, true, model))
  const calls = directCalls.flatMap(projected => projected?.calls?.length ? projected.calls : [projected ?? {}])
  const inputTokens = finiteNumber(usage?.inputTokens)
  const outputTokens = finiteNumber(usage?.outputTokens)
  const reasoningTokens = detailNumber(outputDetails, "reasoningTokens", "reasoningOutputTokens", "reasoning")
    ?? detailNumber(usageDetails, "reasoningOutputTokens")
  const cachedInputTokens = detailNumber(inputDetails, "cacheReadTokens", "cacheRead", "cachedTokens")
    ?? detailNumber(usageDetails, "cachedInputTokens")
  const projected: ConsoleInvocationUsage = {
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(finiteNumber(usage?.totalTokens) !== undefined
      ? { totalTokens: finiteNumber(usage?.totalTokens) }
        : inputTokens !== undefined && outputTokens !== undefined
          ? { totalTokens: inputTokens + outputTokens }
        : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(detailNumber(inputDetails, "cacheWriteTokens", "cacheWrite") !== undefined
      ? { cacheWriteTokens: detailNumber(inputDetails, "cacheWriteTokens", "cacheWrite") }
      : {}),
    ...(projectedCost ? { cost: projectedCost } : {}),
    ...(calls.length ? { calls } : {}),
  }
  if (reasoningTokens !== undefined) projected.reasoningTokens = reasoningTokens
  if (rawCalls.length && allPresent(directCalls)) {
    const assign = <Key extends keyof ConsoleInvocationUsage>(key: Key, value: ConsoleInvocationUsage[Key]) => {
      if (projected[key] === undefined && value !== undefined) projected[key] = value
    }
    assign("inputTokens", sumNumber(directCalls.map(call => call.inputTokens)))
    assign("outputTokens", sumNumber(directCalls.map(call => call.outputTokens)))
    assign("totalTokens", sumNumber(directCalls.map(call => call.totalTokens)))
    assign("cachedInputTokens", sumNumber(directCalls.map(call => call.cachedInputTokens)))
    assign("cacheWriteTokens", sumNumber(directCalls.map(call => call.cacheWriteTokens)))
    assign("reasoningTokens", sumNumber(directCalls.map(call => call.reasoningTokens)))
    assign("cost", sumCost(directCalls.map(call => call.cost)))
  }
  return Object.keys(projected).length ? projected : undefined
}

function invocationUsageProjection(record: AgentInvocationRecord): InvocationUsageProjection {
  const annotations = object(record.annotations)
  const configuredModel = stringValue(annotations?.["agent.model.id"])?.trim()
  for (let index = record.observations.length - 1; index >= 0; index--) {
    const observation = record.observations[index]!
    if (observation.name !== "agent.invocation.finish") continue
    const usage = usageNode(observation.attributes?.["usage.record"], true, configuredModel)
    if (observation.attributes?.["vitehub.observation.truncated"] === true) {
      return { incomplete: true }
    }
    if (usage) return { incomplete: false, usage }
  }
  return { incomplete: false }
}

export function invocationUsage(record: AgentInvocationRecord): ConsoleInvocationUsage | undefined {
  return invocationUsageProjection(record).usage
}

function bucketStart(timestamp: string, resolution: UsageWindow["bucket"]): string | undefined {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.valueOf())) return
  if (resolution === "hour") date.setUTCMinutes(0, 0, 0)
  else date.setUTCHours(0, 0, 0, 0)
  return date.toISOString()
}

function bucketStarts(from: string, to: string, resolution: UsageWindow["bucket"]): string[] {
  const start = bucketStart(from, resolution)
  const end = bucketStart(to, resolution)
  if (!start || !end) return []
  const dates: string[] = []
  const current = new Date(start)
  while (current.toISOString() <= end) {
    dates.push(current.toISOString())
    if (resolution === "hour") current.setUTCHours(current.getUTCHours() + 1)
    else current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

function emptyTotals(): UsageTotal {
  return {
    cacheWriteTokensAvailable: true,
    cacheWriteTokens: 0,
    cachedInputTokensAvailable: true,
    cachedInputTokens: 0,
    costAvailable: true,
    costEstimated: false,
    cost: { scale: 0, units: 0n },
    inputTokensAvailable: true,
    inputTokens: 0,
    invocations: 0,
    outputTokensAvailable: true,
    outputTokens: 0,
    reasoningTokensAvailable: true,
    reasoningTokens: 0,
    totalTokensAvailable: true,
    totalTokens: 0,
  }
}

function addUsage(total: UsageTotal, usage: ConsoleInvocationUsage): void {
  total.invocations++
  total.inputTokensAvailable &&= usage.inputTokens !== undefined
  total.inputTokens += usage.inputTokens ?? 0
  total.outputTokensAvailable &&= usage.outputTokens !== undefined
  total.outputTokens += usage.outputTokens ?? 0
  total.totalTokensAvailable &&= usage.totalTokens !== undefined
  total.totalTokens += usage.totalTokens ?? 0
  total.cachedInputTokensAvailable &&= usage.cachedInputTokens !== undefined
  total.cachedInputTokens += usage.cachedInputTokens ?? 0
  total.cacheWriteTokensAvailable &&= usage.cacheWriteTokens !== undefined
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  total.reasoningTokensAvailable &&= usage.reasoningTokens !== undefined
  total.reasoningTokens += usage.reasoningTokens ?? 0
  const cost = decimal(usage.cost?.usd)
  total.costAvailable &&= cost !== undefined
  total.costEstimated ||= usage.cost?.estimated === true
  if (cost) total.cost = addDecimal(total.cost, cost)
}

function addMissingUsage(total: UsageTotal): void {
  total.invocations++
  total.cacheWriteTokensAvailable = false
  total.cachedInputTokensAvailable = false
  total.costAvailable = false
  total.inputTokensAvailable = false
  total.outputTokensAvailable = false
  total.reasoningTokensAvailable = false
  total.totalTokensAvailable = false
}

function publicTotals(total: UsageTotal, complete = true): PublicUsageTotals {
  const hasEvidence = complete
  return {
    cacheWriteTokensAvailable: hasEvidence && total.cacheWriteTokensAvailable,
    cacheWriteTokens: total.cacheWriteTokens,
    cachedInputTokensAvailable: hasEvidence && total.cachedInputTokensAvailable,
    cachedInputTokens: total.cachedInputTokens,
    costAvailable: hasEvidence && total.costAvailable,
    costEstimated: total.costEstimated,
    costUsd: decimalString(total.cost),
    inputTokensAvailable: hasEvidence && total.inputTokensAvailable,
    inputTokens: total.inputTokens,
    invocationsAvailable: complete,
    invocations: total.invocations,
    outputTokensAvailable: hasEvidence && total.outputTokensAvailable,
    outputTokens: total.outputTokens,
    reasoningTokensAvailable: hasEvidence && total.reasoningTokensAvailable,
    reasoningTokens: total.reasoningTokens,
    totalTokensAvailable: hasEvidence && total.totalTokensAvailable,
    totalTokens: total.totalTokens,
  }
}

function usageTime(record: Pick<AgentInvocationRecord, "completedAt" | "createdAt" | "updatedAt">): string {
  return record.completedAt || record.updatedAt || record.createdAt
}

function consoleError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, statusMessage: message })
}

export async function createUsageSummary(
  invocations: AgentInvocations,
  options: { agentName?: string, now?: Date | number | string, window?: ConsoleUsageWindow } = {},
): Promise<Record<string, unknown>> {
  const windowName = options.window ?? "30d"
  const window = usageWindows[windowName]
  if (!window) throw consoleError("Invalid usage window")
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  if (!Number.isFinite(now.valueOf())) throw consoleError("Invalid usage timestamp")
  const to = now.toISOString()
  const fromDate = new Date(now.valueOf() - window.durationMs)
  const from = fromDate.toISOString()
  const totals = emptyTotals()
  const buckets = new Map<string, UsageTotal>()
  const bucketModels = new Map<string, Map<string, UsageTotal>>()
  const models = new Map<string, UsageTotal>()
  let cursor: string | undefined
  let recordedUsage = 0
  let scanned = 0
  let partial = false
  let scanTruncated = false

  do {
    const page = await invocations.list({
      ...(options.agentName ? { agentName: options.agentName } : {}),
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(100, maximumUsageRecords - scanned),
      status: "completed",
    })
    scanned += page.invocations.length
    const summaries = page.invocations.filter((summary) => {
      const timestamp = Date.parse(usageTime(summary))
      return summary.status === "completed"
        && timestamp >= fromDate.valueOf()
        && timestamp <= now.valueOf()
    })
    const records = await Promise.all(summaries.map(summary => invocations.get(summary.id)))
    for (const [index, record] of records.entries()) {
      if (!record) {
        const bucket = bucketStart(usageTime(summaries[index]!), window.bucket)
        if (bucket) {
          const bucketTotal = buckets.get(bucket) ?? emptyTotals()
          addMissingUsage(totals)
          addMissingUsage(bucketTotal)
          buckets.set(bucket, bucketTotal)
        }
        partial = true
        continue
      }
      const bucket = bucketStart(usageTime(record), window.bucket)
      if (!bucket) continue
      const bucketTotal = buckets.get(bucket) ?? emptyTotals()
      const projection = invocationUsageProjection(record)
      const usage = projection.usage
      if (!usage) {
        addMissingUsage(totals)
        addMissingUsage(bucketTotal)
        buckets.set(bucket, bucketTotal)
        partial = true
        continue
      }
      recordedUsage++
      addUsage(totals, usage)
      addUsage(bucketTotal, usage)
      buckets.set(bucket, bucketTotal)
      const calls = usage.calls?.length ? usage.calls : [usage]
      for (const call of calls) {
        const model = call.model || usage.model || "Unknown model"
        const modelTotal = models.get(model) ?? emptyTotals()
        addUsage(modelTotal, call)
        models.set(model, modelTotal)
        const periodModels = bucketModels.get(bucket) ?? new Map<string, UsageTotal>()
        const periodModelTotal = periodModels.get(model) ?? emptyTotals()
        addUsage(periodModelTotal, call)
        periodModels.set(model, periodModelTotal)
        bucketModels.set(bucket, periodModels)
      }
    }
    cursor = page.cursor
    if (scanned >= maximumUsageRecords && cursor !== undefined) {
      partial = true
      scanTruncated = true
    }
  } while (cursor !== undefined && scanned < maximumUsageRecords)

  const publicTotal = publicTotals(totals, !scanTruncated)

  return {
    available: recordedUsage > 0,
    buckets: bucketStarts(from, to, window.bucket)
      .map(start => ({
        start,
        ...publicTotals(buckets.get(start) ?? emptyTotals(), !scanTruncated),
        models: [...(bucketModels.get(start) ?? new Map<string, UsageTotal>()).entries()]
          .map(([model, modelTotal]) => ({ model, ...publicTotals(modelTotal, !scanTruncated) })),
      })),
    costAvailable: publicTotal.costAvailable,
    from,
    generatedAt: new Date().toISOString(),
    models: [...models.entries()]
      .map(([model, total]) => ({ model, ...publicTotals(total, !scanTruncated) }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)),
    partial,
    resolution: window.bucket,
    to,
    totals: publicTotal,
  }
}
