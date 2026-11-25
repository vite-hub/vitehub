import * as v from "valibot"

import { invariantError } from "@vite-hub/internal/invariant"
import { agentDiagnostics } from "./agent-diagnostics.ts"

import { isRuntimeRecord } from "./internal/runtime-type.ts"
import { agentUsageCostParts, agentUsageFractionDigits, agentUsageMetrics, agentUsageStatement, usageIdBindings } from "./invocations/usage-sql.ts"

export interface AgentUsageCost {
  display: string
  estimated: boolean
  source: string
  usd: string
}

export interface AgentInvocationUsage {
  cacheWriteTokens?: number
  cachedInputTokens?: number
  calls?: AgentInvocationUsage[]
  cost?: AgentUsageCost
  inputTokens?: number
  model?: string
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface AgentUsageTotal {
  cacheWriteTokensAvailable: boolean
  cacheWriteTokens: number
  cachedInputTokensAvailable: boolean
  cachedInputTokens: number
  costAvailable: boolean
  costEstimated: boolean
  cost: AgentUsageDecimal
  inputTokensAvailable: boolean
  inputTokens: number
  invocations: number
  pricedInvocations: number
  outputTokensAvailable: boolean
  outputTokens: number
  reasoningTokensAvailable: boolean
  reasoningTokens: number
  totalTokensAvailable: boolean
  totalTokens: number
}

export interface AgentUsageDecimal {
  scale: number
  units: bigint
}

export interface AgentUsageTotals {
  cacheWriteTokensAvailable: boolean
  cacheWriteTokens: number
  cachedInputTokensAvailable: boolean
  cachedInputTokens: number
  costAvailable: boolean
  costEstimated: boolean
  costUsd: string
  averageCostUsd?: string
  inputTokensAvailable: boolean
  inputTokens: number
  invocationsAvailable: boolean
  invocations: number
  pricedInvocations: number
  outputTokensAvailable: boolean
  outputTokens: number
  reasoningTokensAvailable: boolean
  reasoningTokens: number
  totalTokensAvailable: boolean
  totalTokens: number
}

export type AgentUsageWindowName = "24h" | "7d" | "14d" | "30d" | "90d"

export type AgentUsageStatus = "completed" | "failed" | "cancelled"

export interface AgentUsageQuery {
  agentName?: string
  cursor?: string
  now?: Date | number | string
  search?: string
  status?: AgentUsageStatus
  window?: AgentUsageWindowName
}

export interface AgentUsageSession {
  id: string
  agent: string
  title?: string
  status: string
  at: string
  createdAt: string
  models: string[]
  partial: boolean
  totals: AgentUsageTotals
}

export interface AgentUsageWindow {
  bucket: "day" | "hour"
  durationMs: number
}

export interface AgentUsagePeriod {
  windowName: AgentUsageWindowName
  window: AgentUsageWindow
  now: Date
  to: string
  from: string
  after: { at: string, id: string } | undefined
}

export type AgentUsagePeriodProblem = "cursor" | "timestamp" | "window"

export interface AgentUsageRun {
  id: string
  agent: string
  status: string
  at: string
  usage?: AgentInvocationUsage
}

export interface AgentUsageModelTotals extends AgentUsageTotals {
  model: string
}

export interface AgentUsageSummary {
  available: boolean
  sessions: AgentUsageSession[]
  sessionCount: number
  costSupported: boolean
  agents: Array<AgentUsageTotals & { agent: string }>
  runs: AgentUsageRun[]
  cursor?: string
  expensive: AgentUsageRun[]
  buckets: Array<AgentUsageTotals & { start: string, models: AgentUsageModelTotals[] }>
  costAvailable: boolean
  from: string
  generatedAt: string
  models: AgentUsageModelTotals[]
  partial: boolean
  resolution: AgentUsageWindow["bucket"]
  to: string
  totals: AgentUsageTotals
}

/** An observation as the usage projection reads it. */
export interface AgentUsageObservation {
  name?: string
  attributes?: Readonly<Record<string, unknown>>
}

/**
 * A journal row that the usage projection reads: an Invocation summary and its usage observations.
 * An `AgentInvocationRecord` is a source. A source without `observations` is a row whose record could not be read.
 */
export interface AgentUsageSource {
  id: string
  agentName?: string
  title?: string
  status: string
  createdAt: string
  completedAt?: string
  updatedAt: string
  annotations?: Readonly<Record<string, unknown>>
  observations?: readonly AgentUsageObservation[]
}

/** The usage of one Invocation, projected from its source. `summarizeAgentUsage()` adds these rows up. */
export interface AgentUsageRow {
  id: string
  agentName: string
  title?: string
  status: string
  at: string
  createdAt: string
  updatedAt: string
  configuredModel?: string
  usage?: AgentInvocationUsage
  incomplete: boolean
  missing?: boolean
}

/** The statuses that `summarizeAgentUsage()` counts. */
export const agentUsageStatuses: readonly AgentUsageStatus[] = ["completed", "failed", "cancelled"]

const modelAnnotation = "agent.model.id"

const usageWindows: Record<AgentUsageWindowName, AgentUsageWindow> = {
  "24h": { bucket: "hour", durationMs: 24 * 60 * 60 * 1_000 },
  "7d": { bucket: "day", durationMs: 7 * 24 * 60 * 60 * 1_000 },
  "14d": { bucket: "day", durationMs: 14 * 24 * 60 * 60 * 1_000 },
  "30d": { bucket: "day", durationMs: 30 * 24 * 60 * 60 * 1_000 },
  "90d": { bucket: "day", durationMs: 90 * 24 * 60 * 60 * 1_000 },
}

export function parseAgentUsageStatus(value: string): AgentUsageStatus | undefined {
  if (value === "completed" || value === "failed" || value === "cancelled") return value
}

export function parseAgentUsageWindow(value: string): AgentUsageWindowName | undefined {
  if (value === "24h" || value === "7d" || value === "14d" || value === "30d" || value === "90d") return value
}

const historyCursorSchema = v.strictObject({
  version: v.literal(1),
  to: v.string(),
  at: v.string(),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  scope: v.string(),
})

function cursorScope(options: AgentUsageQuery): string {
  return JSON.stringify([
    options.window ?? "30d",
    options.agentName ?? null,
    options.status ?? null,
    options.search?.toLowerCase() ?? null,
  ])
}

function decodeUsageCursor(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  if (btoa(binary).replace(/=+$/, "") !== normalized) return
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function parseUsageCursor(options: AgentUsageQuery, window: AgentUsageWindow): v.InferOutput<typeof historyCursorSchema> | undefined {
  if (options.cursor === undefined || options.cursor.length > 32_768) return
  const bytes = decodeUsageCursor(options.cursor)
  if (!bytes) return
  try {
    const after = v.parse(historyCursorSchema, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    if (
      after.scope !== cursorScope(options)
      || new Date(after.to).toISOString() !== after.to
      || new Date(after.at).toISOString() !== after.at
      || after.at > after.to
      || Date.parse(after.at) < Date.parse(after.to) - window.durationMs
    ) return
    return after
  } catch {
    return undefined
  }
}

/** Resolves the date window of a usage query. A cursor keeps every page inside the first page's window and filters. */
export function agentUsagePeriod(options: AgentUsageQuery): AgentUsagePeriod | { problem: AgentUsagePeriodProblem } {
  const windowName = options.window ?? "30d"
  const window = usageWindows[windowName]
  if (!window) return { problem: "window" }
  const after = options.cursor === undefined ? undefined : parseUsageCursor(options, window)
  if (options.cursor !== undefined && !after) return { problem: "cursor" }
  const now = new Date(after?.to ?? options.now ?? Date.now())
  if (!Number.isFinite(now.valueOf())) return { problem: "timestamp" }
  return {
    windowName,
    window,
    now,
    to: now.toISOString(),
    from: new Date(now.valueOf() - window.durationMs).toISOString(),
    after,
  }
}

export function agentUsageCursor(options: AgentUsageQuery, to: string, last: { at: string, id: string }): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, to, at: new Date(last.at).toISOString(), id: last.id, scope: cursorScope(options) }),
  )
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function compareText(left: string, right: string): number {
  let a = 0
  let b = 0
  while (a < left.length && b < right.length) {
    const l = left.codePointAt(a) ?? 0
    const r = right.codePointAt(b) ?? 0
    if (l !== r) return l - r
    a += l > 0xffff ? 2 : 1
    b += r > 0xffff ? 2 : 1
  }
  return left.length - a - (right.length - b)
}

function compareSessions(left: { at: string, id: string }, right: { at: string, id: string }): number {
  return Date.parse(right.at) - Date.parse(left.at) || compareText(right.id, left.id)
}

const finiteNumberSchema = v.pipe(v.number(), v.check((value: number) => Number.isFinite(value)), v.minValue(0))
const stringSchema = v.string()

function object(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
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

export function usageDecimal(value: string | undefined): AgentUsageDecimal | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return
  const [whole, fraction = ""] = value.split(".")
  return { scale: fraction.length, units: BigInt(`${whole}${fraction}`) }
}

export function usageString(value: unknown): string | undefined {
  const result = v.safeParse(stringSchema, value)
  return result.success ? result.output : undefined
}

export function addUsageDecimal(left: AgentUsageDecimal, right: AgentUsageDecimal): AgentUsageDecimal {
  const scale = Math.max(left.scale, right.scale)
  return {
    scale,
    units: left.units * 10n ** BigInt(scale - left.scale) + right.units * 10n ** BigInt(scale - right.scale),
  }
}

export function usageDecimalString(value: AgentUsageDecimal): string {
  if (value.scale === 0) return value.units.toString()
  const scale = 10n ** BigInt(value.scale)
  const whole = value.units / scale
  const fraction = (value.units % scale).toString().padStart(value.scale, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function compareUsageCost(left?: AgentUsageCost, right?: AgentUsageCost): number {
  const a = usageDecimal(left?.usd) ?? { scale: 0, units: 0n }
  const b = usageDecimal(right?.usd) ?? { scale: 0, units: 0n }
  const scale = Math.max(a.scale, b.scale)
  const difference = a.units * 10n ** BigInt(scale - a.scale) - b.units * 10n ** BigInt(scale - b.scale)
  return difference > 0n ? 1 : difference < 0n ? -1 : 0
}

function allPresent<T>(values: Array<T | undefined>): values is T[] {
  return values.every(value => value !== undefined)
}

function sumNumber(values: Array<number | undefined>): number | undefined {
  if (!values.length || !allPresent(values)) return
  return values.reduce((total, value) => total + value, 0)
}

function sumCost(values: Array<AgentUsageCost | undefined>): AgentUsageCost | undefined {
  const decimals = values.map(value => usageDecimal(value?.usd))
  if (!decimals.length || !allPresent(decimals)) return
  const total = decimals.reduce(addUsageDecimal, { scale: 0, units: 0n })
  const estimated = values.some(value => value?.estimated === true)
  const sources = [...new Set(values.flatMap(value => (value?.source ? [value.source] : [])))]
  const usd = usageDecimalString(total)
  return {
    display: `${estimated ? "~" : ""}$${usd}`,
    estimated,
    source: sources.length === 1 && sources[0] ? sources[0] : "mixed",
    usd,
  }
}

/** Projects a `usage.record` value: token counts, cost and per-call rows. */
export function usageNode(value: unknown, includeCalls = true, inheritedModel?: string): AgentInvocationUsage | undefined {
  const record = object(value)
  if (!record) return
  const usage = object(record.usage)
  const inputDetails = object(usage?.inputTokenDetails)
  const outputDetails = object(usage?.outputTokenDetails)
  const usageDetails = object(usage?.details)
  const cost = object(record.cost)
  const costUsd = usageString(cost?.usd)
  const costValue = usageDecimal(costUsd)
  const projectedCost: AgentUsageCost | undefined = costValue === undefined || costUsd === undefined
    ? undefined
    : {
        display: usageString(cost?.display) ?? `$${costUsd}`,
        estimated: cost?.estimated === true,
        source: usageString(cost?.source) ?? "provider",
        usd: costUsd,
      }
  const model = usageString(record.model)?.trim() || inheritedModel
  const rawCalls = includeCalls && Array.isArray(record.calls) ? record.calls : []
  const directCalls = rawCalls.map(call => usageNode(call, true, model))
  const calls = directCalls.flatMap(projected => projected?.calls?.length ? projected.calls : [projected ?? {}])
  const inputTokens = finiteNumber(usage?.inputTokens)
  const outputTokens = finiteNumber(usage?.outputTokens)
  const totalTokens = finiteNumber(usage?.totalTokens)
  const reasoningTokens = detailNumber(outputDetails, "reasoningTokens", "reasoningOutputTokens", "reasoning")
    ?? detailNumber(usageDetails, "reasoningOutputTokens")
  const cachedInputTokens = detailNumber(inputDetails, "cacheReadTokens", "cacheRead", "cachedTokens")
    ?? detailNumber(usageDetails, "cachedInputTokens")
  const cacheWriteTokens = detailNumber(inputDetails, "cacheWriteTokens", "cacheWrite")
  const projected: AgentInvocationUsage = {
    ...(model ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined
      ? { totalTokens }
      : inputTokens !== undefined && outputTokens !== undefined
        ? { totalTokens: inputTokens + outputTokens }
        : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(projectedCost ? { cost: projectedCost } : {}),
    ...(calls.length ? { calls } : {}),
  }
  if (reasoningTokens !== undefined) projected.reasoningTokens = reasoningTokens
  if (rawCalls.length && allPresent(directCalls)) {
    const assign = <Key extends keyof AgentInvocationUsage>(key: Key, value: AgentInvocationUsage[Key]) => {
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

/** Combines auxiliary calls per Invocation and model before run averages. */
export function modelUsage(usage: AgentInvocationUsage): Map<string, AgentInvocationUsage> {
  const groups = new Map<string, AgentInvocationUsage[]>()
  for (const call of usage.calls?.length ? usage.calls : [usage]) {
    const model = call.model || usage.model || "Unknown model"
    const calls = groups.get(model)
    if (calls) calls.push(call)
    else groups.set(model, [call])
  }
  return new Map([...groups].map(([model, calls]) => [
    model,
    usageNode({
      model,
      calls: calls.map(call => ({
        model: call.model,
        cost: call.cost,
        usage: {
          ...call,
          inputTokenDetails: { cacheReadTokens: call.cachedInputTokens, cacheWriteTokens: call.cacheWriteTokens },
          outputTokenDetails: { reasoningTokens: call.reasoningTokens },
        },
      })),
    }) ?? { model },
  ]))
}

/**
 * Projects the usage record of a finish observation. A long result text also marks the observation truncated, but
 * the Agent keeps the scalar totals of `usage.record` when it bounds the observation. A truncated observation keeps
 * those totals and drops per-call rows, because a bounded call list can be incomplete.
 */
export function finishUsage(value: unknown, truncated: boolean, configuredModel?: string): AgentInvocationUsage | undefined {
  const projected = usageNode(value, !truncated, configuredModel)
  if (!truncated || !projected) return projected
  const { calls: _calls, ...scalar } = projected
  return scalar
}

/**
 * Adds the cost of the `agent.usage.recorded` observations to a finish usage without one. An imported session can
 * price its usage after the run. Every usage observation must carry a cost, or the cost stays unknown.
 */
export function withRecordedCost(
  usage: AgentInvocationUsage | undefined,
  observations: readonly AgentUsageObservation[],
): AgentInvocationUsage | undefined {
  if (!usage || usage.cost) return usage
  const costs = observations
    .filter(observation => observation.name === "agent.usage.recorded")
    .map(({ attributes }) => {
      const usd = usageString(attributes?.["usage.costUsd"])
      if (!usd || attributes?.["usage.hasCost"] === false || usageDecimal(usd) === undefined) return undefined
      const source = usageString(attributes?.["usage.costSource"])
      return { display: "", estimated: attributes?.["usage.costEstimated"] === true, source: source ?? "provider", usd }
    })
  const cost = sumCost(costs)
  return cost ? { ...usage, cost } : usage
}

function configuredModelOf(source: Pick<AgentUsageSource, "annotations">): string | undefined {
  return usageString(object(source.annotations)?.[modelAnnotation])?.trim()
}

function usageProjection(source: AgentUsageSource): { incomplete: boolean, usage?: AgentInvocationUsage } {
  const observations = source.observations ?? []
  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index]
    if (observation?.name !== "agent.invocation.finish") continue
    const incomplete = observation.attributes?.["vitehub.observation.truncated"] === true
    const usage = finishUsage(observation.attributes?.["usage.record"], incomplete, configuredModelOf(source))
    return { incomplete, usage: withRecordedCost(usage, observations) }
  }
  return { incomplete: false }
}

/** The usage of one Invocation record, from its last finish observation. */
export function invocationUsage(source: AgentUsageSource): AgentInvocationUsage | undefined {
  return usageProjection(source).usage
}

function usageTime(record: Pick<AgentUsageSource, "completedAt" | "createdAt" | "updatedAt">): string {
  return record.completedAt || record.updatedAt || record.createdAt
}

/** Projects one journal row into the usage row that `summarizeAgentUsage()` adds up. */
export function agentUsageRow(source: AgentUsageSource): AgentUsageRow {
  const configuredModel = configuredModelOf(source)
  const projection = source.observations ? usageProjection(source) : { incomplete: false }
  return {
    id: source.id,
    agentName: source.agentName ?? "",
    ...(source.title ? { title: source.title } : {}),
    status: source.status,
    at: usageTime(source),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(configuredModel ? { configuredModel } : {}),
    ...(projection.usage ? { usage: projection.usage } : {}),
    incomplete: projection.incomplete,
    ...(source.observations ? {} : { missing: true }),
  }
}

function rowSession(row: AgentUsageRow): AgentUsageSession {
  const totals = emptyUsageTotal()
  if (row.usage) addUsage(totals, row.usage)
  else addMissingUsage(totals)
  return {
    id: row.id,
    agent: row.agentName,
    ...(row.title ? { title: row.title } : {}),
    status: row.status,
    at: row.at,
    createdAt: row.createdAt,
    models: row.usage ? [...modelUsage(row.usage).keys()] : row.configuredModel ? [row.configuredModel] : [],
    partial: row.incomplete || row.usage?.totalTokens === undefined,
    totals: publicUsageTotals(totals),
  }
}

/** Console sessions use durable Invocation IDs. Transport thread IDs do not identify provider sessions. */
export function usageSession(
  record: Omit<AgentUsageSource, "observations">,
  usage?: AgentInvocationUsage,
  incomplete = false,
): AgentUsageSession {
  return rowSession({ ...agentUsageRow(record), ...(usage ? { usage } : {}), incomplete })
}

function bucketStart(timestamp: string, resolution: AgentUsageWindow["bucket"]): string | undefined {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.valueOf())) return
  if (resolution === "hour") date.setUTCMinutes(0, 0, 0)
  else date.setUTCHours(0, 0, 0, 0)
  return date.toISOString()
}

function bucketStarts(from: string, to: string, resolution: AgentUsageWindow["bucket"]): string[] {
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

export function emptyUsageTotal(): AgentUsageTotal {
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
    pricedInvocations: 0,
    outputTokensAvailable: true,
    outputTokens: 0,
    reasoningTokensAvailable: true,
    reasoningTokens: 0,
    totalTokensAvailable: true,
    totalTokens: 0,
  }
}

function addUsage(total: AgentUsageTotal, usage: AgentInvocationUsage): void {
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
  const cost = usageDecimal(usage.cost?.usd)
  total.costAvailable &&= cost !== undefined
  total.costEstimated ||= usage.cost?.estimated === true
  if (cost) {
    total.cost = addUsageDecimal(total.cost, cost)
    total.pricedInvocations++
  }
}

function addMissingUsage(total: AgentUsageTotal): void {
  total.invocations++
  total.cacheWriteTokensAvailable = false
  total.cachedInputTokensAvailable = false
  total.costAvailable = false
  total.inputTokensAvailable = false
  total.outputTokensAvailable = false
  total.reasoningTokensAvailable = false
  total.totalTokensAvailable = false
}

export function publicUsageTotals(total: AgentUsageTotal, complete = true): AgentUsageTotals {
  return {
    cacheWriteTokensAvailable: complete && total.cacheWriteTokensAvailable,
    cacheWriteTokens: total.cacheWriteTokens,
    cachedInputTokensAvailable: complete && total.cachedInputTokensAvailable,
    cachedInputTokens: total.cachedInputTokens,
    costAvailable: complete && total.costAvailable,
    costEstimated: total.costEstimated,
    costUsd: usageDecimalString(total.cost),
    ...(total.pricedInvocations
      ? {
          averageCostUsd: usageDecimalString({
            scale: total.cost.scale + 8,
            units: (total.cost.units * 100_000_000n) / BigInt(total.pricedInvocations),
          }),
        }
      : {}),
    pricedInvocations: total.pricedInvocations,
    inputTokensAvailable: complete && total.inputTokensAvailable,
    inputTokens: total.inputTokens,
    invocationsAvailable: complete,
    invocations: total.invocations,
    outputTokensAvailable: complete && total.outputTokensAvailable,
    outputTokens: total.outputTokens,
    reasoningTokensAvailable: complete && total.reasoningTokensAvailable,
    reasoningTokens: total.reasoningTokens,
    totalTokensAvailable: complete && total.totalTokensAvailable,
    totalTokens: total.totalTokens,
  }
}

/** Bucket and global model breakdowns use the same deterministic ranking. */
export function compareUsageModels(
  left: { model: string, totalTokens: number },
  right: { model: string, totalTokens: number },
): number {
  return right.totalTokens - left.totalTokens || left.model.localeCompare(right.model)
}

function matchesUsageSearch(row: { agentName: string, id: string, title?: string | undefined }, search: string | undefined): boolean {
  const text = search?.toLowerCase()
  return !text || [row.id, row.title ?? "", row.agentName].some(value => value.toLowerCase().includes(text))
}

/** Keeps the rows that a usage query counts: terminal, inside the window, and matching the filters. */
export function matchesAgentUsageQuery(row: Pick<AgentUsageRow, "id" | "agentName" | "title" | "status" | "at">, options: AgentUsageQuery, period: AgentUsagePeriod): boolean {
  const timestamp = Date.parse(row.at)
  return agentUsageStatuses.some(status => status === row.status)
    && (!options.status || row.status === options.status)
    && (!options.agentName || row.agentName === options.agentName)
    && matchesUsageSearch(row, options.search)
    && timestamp >= Date.parse(period.from)
    && timestamp <= period.now.valueOf()
}

function usageRun(row: AgentUsageRow): AgentUsageRun {
  return { id: row.id, agent: row.agentName, status: row.status, at: row.at, ...(row.usage ? { usage: row.usage } : {}) }
}

interface UsageParts {
  agents: Map<string, AgentUsageTotal>
  bucketModels: Map<string, Map<string, AgentUsageTotal>>
  buckets: Map<string, AgentUsageTotal>
  expensive: AgentUsageRun[]
  models: Map<string, AgentUsageTotal>
  page: AgentUsageRow[]
  partial: boolean
  sessionCount: number
  totals: AgentUsageTotal
}

function usageSummary(parts: UsageParts, options: AgentUsageQuery, period: AgentUsagePeriod): AgentUsageSummary {
  const { window, to, from } = period
  const { page, totals } = parts
  const sessions = page.slice(0, 50)
  const last = page[49]
  const publicTotal = publicUsageTotals(totals)
  const modelTotals = (entries: Map<string, AgentUsageTotal>) => [...entries]
    .map(([model, total]) => ({ model, ...publicUsageTotals(total) }))
    .sort(compareUsageModels)
  return {
    available: totals.invocations > 0,
    sessions: sessions.map(rowSession),
    sessionCount: parts.sessionCount,
    costSupported: totals.pricedInvocations > 0,
    agents: [...parts.agents].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([agent, total]) => ({ agent, ...publicUsageTotals(total) })),
    runs: sessions.filter(row => !row.missing).map(usageRun),
    ...(page.length > 50 && last ? { cursor: agentUsageCursor(options, to, last) } : {}),
    expensive: parts.expensive,
    buckets: bucketStarts(from, to, window.bucket).map(start => ({
      start,
      ...publicUsageTotals(parts.buckets.get(start) ?? emptyUsageTotal()),
      models: modelTotals(parts.bucketModels.get(start) ?? new Map<string, AgentUsageTotal>()),
    })),
    costAvailable: publicTotal.costAvailable,
    from,
    generatedAt: new Date().toISOString(),
    models: modelTotals(parts.models),
    partial: parts.partial,
    resolution: window.bucket,
    to,
    totals: publicTotal,
  }
}

/**
 * Adds up usage rows into the answer of the `invocations.usage` Console operation. It reads no storage: pass every row of
 * the window and the period from `agentUsagePeriod()`.
 */
export function summarizeAgentUsage(rows: Iterable<AgentUsageRow>, options: AgentUsageQuery, period: AgentUsagePeriod): AgentUsageSummary {
  const totals = emptyUsageTotal()
  const buckets = new Map<string, AgentUsageTotal>()
  const bucketModels = new Map<string, Map<string, AgentUsageTotal>>()
  const models = new Map<string, AgentUsageTotal>()
  const agents = new Map<string, AgentUsageTotal>()
  const selected: AgentUsageRow[] = []
  let partial = false
  const add = <Key>(map: Map<Key, AgentUsageTotal>, key: Key, usage: AgentInvocationUsage | undefined) => {
    const total = map.get(key) ?? emptyUsageTotal()
    if (usage) addUsage(total, usage)
    else addMissingUsage(total)
    map.set(key, total)
  }

  for (const row of rows) {
    if (!matchesAgentUsageQuery(row, options, period)) continue
    const bucket = bucketStart(row.at, period.window.bucket)
    if (row.missing) {
      if (bucket) {
        addMissingUsage(totals)
        add(buckets, bucket, undefined)
      }
      selected.push(row)
      add(agents, row.agentName, undefined)
      partial = true
      continue
    }
    if (!bucket) continue
    const usage = row.usage
    partial ||= row.incomplete || usage?.totalTokens === undefined
    selected.push(row)
    add(agents, row.agentName, usage)
    if (!usage) {
      addMissingUsage(totals)
      add(buckets, bucket, undefined)
      partial = true
      continue
    }
    addUsage(totals, usage)
    add(buckets, bucket, usage)
    for (const [model, call] of modelUsage(usage)) {
      add(models, model, call)
      const periodModels = bucketModels.get(bucket) ?? new Map<string, AgentUsageTotal>()
      add(periodModels, model, call)
      bucketModels.set(bucket, periodModels)
    }
  }

  selected.sort(compareSessions)
  const { after } = period
  return usageSummary({
    agents,
    bucketModels,
    buckets,
    expensive: selected
      .filter(row => !row.missing && row.usage?.cost)
      .sort((a, b) => compareUsageCost(b.usage?.cost, a.usage?.cost))
      .slice(0, 10)
      .map(usageRun),
    models,
    page: selected.filter(row => !after || compareSessions(row, after) > 0).slice(0, 51),
    partial,
    sessionCount: selected.length,
    totals,
  }, options, period)
}

/** A SQL client that runs one read statement, such as a libSQL client or a D1 database adapter. */
export interface AgentUsageSqlClient {
  execute: (statement: { sql: string, args: Array<string | number> }) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>
}

function usageData(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : undefined
  if (!isRuntimeRecord(parsed)) throw invariantError("the Agent usage statement returns a JSON object in each data column")
  return parsed
}

function sqlUsageTotal(data: Record<string, unknown>): AgentUsageTotal {
  const total = emptyUsageTotal()
  const invocations = Number(data.n ?? 0)
  total.invocations = invocations
  for (const metric of agentUsageMetrics) {
    total[metric] = Number(data[metric] ?? 0)
    total[`${metric}Available`] = Number(data[`${metric}Count`] ?? 0) === invocations
  }
  total.pricedInvocations = Number(data.priced ?? 0)
  total.costAvailable = total.pricedInvocations === invocations
  total.costEstimated = Number(data.estimated ?? 0) === 1
  const scale = Number(data.scale ?? 0)
  const units = agentUsageCostParts.reduce((sum, part, index) => {
    const value = data[part]
    return sum + (typeof value === "string" ? BigInt(value) : 0n) * 10n ** BigInt(agentUsageFractionDigits - 9 * index)
  }, 0n)
  total.cost = { scale, units: units / 10n ** BigInt(agentUsageFractionDigits - scale) }
  return total
}

function usageObservations(value: unknown): AgentUsageObservation[] {
  const item = object(value)
  if (!item) return []
  const attributes = object(item.attributes)
  return [{ ...(typeof item.name === "string" ? { name: item.name } : {}), ...(attributes ? { attributes } : {}) }]
}

function sqlUsageRow(data: Record<string, unknown>): AgentUsageRow {
  const text = (value: unknown) => usageString(value)
  const title = text(data.title)
  const completedAt = text(data.completedAt)
  const model = text(data.model)
  const finish = usageObservations(data.finish)
  const recorded = Array.isArray(data.recorded) ? data.recorded.flatMap(usageObservations) : []
  return agentUsageRow({
    id: String(data.id),
    agentName: text(data.agentName) ?? "",
    ...(title === undefined ? {} : { title }),
    status: String(data.status),
    createdAt: text(data.createdAt) ?? "",
    ...(completedAt === undefined ? {} : { completedAt }),
    updatedAt: text(data.updatedAt) ?? "",
    ...(model === undefined ? {} : { annotations: { [modelAnnotation]: model } }),
    ...(Number(data.missing) === 1 ? {} : { observations: [...finish, ...recorded] }),
  })
}

async function searchedUsageIds(client: AgentUsageSqlClient, table: string, options: AgentUsageQuery, period: AgentUsagePeriod): Promise<string[]> {
  const { rows } = await client.execute(agentUsageStatement(table, options, period, undefined, "candidates"))
  return rows
    .map(row => ({ agentName: usageString(row.agent) ?? "", id: String(row.id), title: usageString(row.title) }))
    .filter(row => matchesUsageSearch(row, options.search))
    .map(row => row.id)
}

/**
 * Answers a usage query from a SQLite, libSQL, or D1 Agent journal with the same answer as `summarizeAgentUsage()`.
 * One SQL statement groups and adds up the Invocations of the window, nested calls included, and returns the totals and
 * at most 61 Invocations: one page of sessions and the most expensive runs. A search first reads the id, title, and
 * Agent name of the window, so the match uses the same Unicode lowercase as `summarizeAgentUsage()`. Unusually large
 * or precise prices, or searches that exceed the SQL binding budget, read usage evidence instead. It creates no table.
 */
export async function readAgentUsage(
  client: AgentUsageSqlClient,
  options: AgentUsageQuery,
  period: AgentUsagePeriod,
  settings: { table?: string } = {},
): Promise<AgentUsageSummary> {
  const table = settings.table ?? "vitehub_agent_invocations"
  if (!/^[A-Za-z_]\w*$/.test(table)) throw agentDiagnostics.AGENT_INVOCATIONS_TABLE_PREFIX_INVALID()
  const idBindings = options.search === undefined ? undefined : usageIdBindings(await searchedUsageIds(client, table, options, period))
  const readEvidence = async () => {
    const exact = await client.execute(agentUsageStatement(table, options, period, idBindings, "exact"))
    return summarizeAgentUsage(exact.rows.map(row => sqlUsageRow(usageData(row.data))), options, period)
  }
  if (options.search !== undefined && !idBindings) return readEvidence()
  const { rows } = await client.execute(agentUsageStatement(table, options, period, idBindings))
  let totals = emptyUsageTotal()
  let partial = false
  const buckets = new Map<string, AgentUsageTotal>()
  const bucketModels = new Map<string, Map<string, AgentUsageTotal>>()
  const agents = new Map<string, AgentUsageTotal>()
  const models = new Map<string, AgentUsageTotal>()
  const page: AgentUsageRow[] = []
  const expensive: AgentUsageRun[] = []
  for (const row of rows) {
    const data = usageData(row.data)
    const key = usageString(row.key) ?? ""
    const model = usageString(row.model) ?? ""
    if (row.kind === "total") {
      if (Number(data.exact) === 1) return readEvidence()
      totals = sqlUsageTotal(data)
      partial = Number(data.partial ?? 0) === 1
    }
    else if (row.kind === "bucket") buckets.set(key, sqlUsageTotal(data))
    else if (row.kind === "agent") agents.set(key, sqlUsageTotal(data))
    else if (row.kind === "model") models.set(model, sqlUsageTotal(data))
    else if (row.kind === "bucketModel") bucketModels.set(key, (bucketModels.get(key) ?? new Map()).set(model, sqlUsageTotal(data)))
    else if (row.kind === "page") page.push(sqlUsageRow(data))
    else if (row.kind === "expensive") expensive.push(usageRun(sqlUsageRow(data)))
  }
  return usageSummary({ agents, bucketModels, buckets, expensive, models, page, partial, sessionCount: totals.invocations, totals }, options, period)
}
