import type { AgentInvocationRecord, AgentInvocations } from "@vite-hub/agent"

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

interface UsageWindow {
  bucket: "day" | "hour"
  durationMs: number
}

interface UsageTotal {
  cacheWriteTokens: number
  cachedInputTokens: number
  costAvailable: boolean
  costUnits: bigint
  inputTokens: number
  invocations: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

interface PublicUsageTotals {
  cacheWriteTokens: number
  cachedInputTokens: number
  costUsd: string
  inputTokens: number
  invocations: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export type ConsoleUsageWindow = "24h" | "7d" | "30d" | "90d"

const usageWindows: Record<ConsoleUsageWindow, UsageWindow> = {
  "24h": { bucket: "hour", durationMs: 24 * 60 * 60 * 1_000 },
  "7d": { bucket: "day", durationMs: 7 * 24 * 60 * 60 * 1_000 },
  "30d": { bucket: "day", durationMs: 30 * 24 * 60 * 60 * 1_000 },
  "90d": { bucket: "day", durationMs: 90 * 24 * 60 * 60 * 1_000 },
}

const decimalPlaces = 18
const decimalScale = 10n ** BigInt(decimalPlaces)
const maximumUsageRecords = 10_000

function object(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function detailNumber(details: unknown, ...keys: string[]): number | undefined {
  const value = object(details)
  if (!value) return
  for (const key of keys) {
    const resolved = finiteNumber(value[key])
    if (resolved !== undefined) return resolved
  }
}

function decimalUnits(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return
  const [whole, fraction = ""] = value.split(".")
  const padded = `${fraction}${"0".repeat(decimalPlaces)}`.slice(0, decimalPlaces)
  return BigInt(whole!) * decimalScale + BigInt(padded)
}

function decimalString(value: bigint): string {
  const whole = value / decimalScale
  const fraction = (value % decimalScale)
    .toString()
    .padStart(decimalPlaces, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function sumNumber(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length ? present.reduce((total, value) => total + value, 0) : undefined
}

function sumCost(values: Array<ConsoleUsageCost | undefined>): ConsoleUsageCost | undefined {
  const units = values.flatMap((value) => {
    const resolved = decimalUnits(value?.usd)
    return resolved === undefined ? [] : [resolved]
  })
  if (!units.length) return
  const total = units.reduce((sum, value) => sum + value, 0n)
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

function usageNode(value: unknown, includeCalls = true): ConsoleInvocationUsage | undefined {
  const record = object(value)
  if (!record) return
  const usage = object(record.usage)
  const inputDetails = object(usage?.inputTokenDetails)
  const outputDetails = object(usage?.outputTokenDetails)
  const cost = object(record.cost)
  const costUnits = decimalUnits(cost?.usd)
  const projectedCost: ConsoleUsageCost | undefined = costUnits === undefined
    ? undefined
    : {
        display: typeof cost?.display === "string" ? cost.display : `$${cost?.usd}`,
        estimated: cost?.estimated === true,
        source: typeof cost?.source === "string" ? cost.source : "provider",
        usd: String(cost?.usd),
      }
  const calls = includeCalls && Array.isArray(record.calls)
    ? record.calls.flatMap((call) => {
        const projected = usageNode(call, false)
        return projected ? [projected] : []
      })
    : []
  const inputTokens = finiteNumber(usage?.inputTokens)
  const outputTokens = finiteNumber(usage?.outputTokens)
  const projected: ConsoleInvocationUsage = {
    ...(typeof record.model === "string" && record.model.trim() ? { model: record.model.trim() } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(finiteNumber(usage?.totalTokens) !== undefined
      ? { totalTokens: finiteNumber(usage?.totalTokens) }
      : inputTokens !== undefined || outputTokens !== undefined
        ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
        : {}),
    ...(detailNumber(inputDetails, "cacheReadTokens", "cacheRead", "cachedInputTokens") !== undefined
      ? { cachedInputTokens: detailNumber(inputDetails, "cacheReadTokens", "cacheRead", "cachedInputTokens") }
      : {}),
    ...(detailNumber(inputDetails, "cacheWriteTokens", "cacheWrite") !== undefined
      ? { cacheWriteTokens: detailNumber(inputDetails, "cacheWriteTokens", "cacheWrite") }
      : {}),
    ...(detailNumber(outputDetails, "reasoningTokens", "reasoningOutputTokens", "reasoning") !== undefined
      ? { reasoningTokens: detailNumber(outputDetails, "reasoningTokens", "reasoningOutputTokens", "reasoning") }
      : {}),
    ...(projectedCost ? { cost: projectedCost } : {}),
    ...(calls.length ? { calls } : {}),
  }
  if (calls.length) {
    projected.inputTokens ??= sumNumber(calls.map(call => call.inputTokens))
    projected.outputTokens ??= sumNumber(calls.map(call => call.outputTokens))
    projected.totalTokens ??= sumNumber(calls.map(call => call.totalTokens))
    projected.cachedInputTokens ??= sumNumber(calls.map(call => call.cachedInputTokens))
    projected.cacheWriteTokens ??= sumNumber(calls.map(call => call.cacheWriteTokens))
    projected.reasoningTokens ??= sumNumber(calls.map(call => call.reasoningTokens))
    projected.cost ??= sumCost(calls.map(call => call.cost))
  }
  return Object.keys(projected).length ? projected : undefined
}

export function invocationUsage(record: AgentInvocationRecord): ConsoleInvocationUsage | undefined {
  for (let index = record.observations.length - 1; index >= 0; index--) {
    const observation = record.observations[index]!
    if (observation.name !== "agent.invocation.finish") continue
    const usage = usageNode(observation.attributes?.["usage.record"])
    if (usage) return usage
  }
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
    cacheWriteTokens: 0,
    cachedInputTokens: 0,
    costAvailable: false,
    costUnits: 0n,
    inputTokens: 0,
    invocations: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

function addUsage(total: UsageTotal, usage: ConsoleInvocationUsage): void {
  total.invocations++
  total.inputTokens += usage.inputTokens ?? 0
  total.outputTokens += usage.outputTokens ?? 0
  total.totalTokens += usage.totalTokens ?? 0
  total.cachedInputTokens += usage.cachedInputTokens ?? 0
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  total.reasoningTokens += usage.reasoningTokens ?? 0
  const cost = decimalUnits(usage.cost?.usd)
  if (cost !== undefined) {
    total.costAvailable = true
    total.costUnits += cost
  }
}

function publicTotals(total: UsageTotal): PublicUsageTotals {
  return {
    cacheWriteTokens: total.cacheWriteTokens,
    cachedInputTokens: total.cachedInputTokens,
    costUsd: decimalString(total.costUnits),
    inputTokens: total.inputTokens,
    invocations: total.invocations,
    outputTokens: total.outputTokens,
    reasoningTokens: total.reasoningTokens,
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
  let scanned = 0
  let partial = false
  let reachedStart = false

  do {
    const page = await invocations.list({
      ...(options.agentName ? { agentName: options.agentName } : {}),
      ...(cursor ? { cursor } : {}),
      limit: Math.min(100, maximumUsageRecords - scanned),
    })
    scanned += page.invocations.length
    const summaries = page.invocations.filter((summary) => {
      const timestamp = Date.parse(usageTime(summary))
      if (Number.isFinite(timestamp) && timestamp < fromDate.valueOf()) {
        reachedStart = true
        return false
      }
      return summary.status === "completed" && timestamp <= now.valueOf()
    })
    const records = await Promise.all(summaries.map(summary => invocations.get(summary.id)))
    for (const record of records) {
      if (!record) continue
      const usage = invocationUsage(record)
      if (!usage) continue
      const bucket = bucketStart(usageTime(record), window.bucket)
      if (!bucket) continue
      addUsage(totals, usage)
      const bucketTotal = buckets.get(bucket) ?? emptyTotals()
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
    if (scanned >= maximumUsageRecords && cursor && !reachedStart) partial = true
  } while (cursor && !reachedStart && scanned < maximumUsageRecords)

  return {
    available: totals.invocations > 0,
    buckets: bucketStarts(from, to, window.bucket)
      .map(start => ({
        start,
        ...publicTotals(buckets.get(start) ?? emptyTotals()),
        models: [...(bucketModels.get(start) ?? new Map<string, UsageTotal>()).entries()]
          .map(([model, modelTotal]) => ({ model, ...publicTotals(modelTotal) })),
      })),
    costAvailable: totals.costAvailable,
    from,
    generatedAt: new Date().toISOString(),
    models: [...models.entries()]
      .map(([model, total]) => ({ model, ...publicTotals(total) }))
      .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)),
    partial,
    resolution: window.bucket,
    to,
    totals: publicTotals(totals),
  }
}
