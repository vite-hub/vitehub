import { hasRuntimeType } from "./internal/runtime-type.ts"
import { searchableAgentInvocationText } from "./invocations/search.ts"
import { createTraceEventLog, isTraceContentAttributeKey, normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { registerAgentInvocationRecovery } from "./internal/invocation-recovery.ts"
import { agentInvocationJournalContentTraceLogSymbol, agentInvocationJournalTraceLogSymbol } from "./trace.ts"

import type { AgentInvocationStatus } from "./agent-invocation.ts"
import type { AgentRunMetadata, AgentRuntimeConfig, AgentRuntimeContext, MaybePromise } from "./types.ts"
import type { RuntimeDiagnosticError, TraceEvent, TraceEventContentPolicy, TraceEventLog, TraceEventLogEntry, TraceEventPayload } from "@vite-hub/runtime"
import { agentDiagnostics } from "./agent-diagnostics.ts"

const bindAgentInvocationsSymbol = Symbol("vitehub.bindAgentInvocations")
const agentInvocationsBrand: unique symbol = Symbol("vitehub.agentInvocations")

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_ANNOTATIONS = 32
const MAX_ANNOTATION_KEY_LENGTH = 64
const MAX_ANNOTATION_STRING_LENGTH = 512
const MAX_CAPABILITY_IDS = 256
const MAX_METADATA_STRING_LENGTH = 512
const MAX_OBSERVATION_CONTENT_STRING_LENGTH = 64 * 1024
const MAX_OBSERVATIONS = 256
const DEFAULT_OBSERVATION_BYTES = 16 * 1024 * 1024
const MAX_OBSERVATION_ATTRIBUTES = 32
const MAX_OBSERVATION_COLLECTION_ITEMS = 32
const MAX_OBSERVATION_DEPTH = 4
const MAX_AGENT_CONFIGURATION_DEPTH = 8
const MAX_OBSERVATION_VALUE_ITEMS = 256
export const AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE = "vitehub.observation.truncated"
const AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE = "vitehub.observation.id"
const APPENDED_OBSERVATION_ATTRIBUTE = "vitehub.observation.appended"
const CANONICAL_TRACE_ATTRIBUTE_KEYS = new Set([
  AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE,
  APPENDED_OBSERVATION_ATTRIBUTE,
  "vitehub.activity.owner",
  "vitehub.activity.phase",
  "vitehub.payload.summary",
  "vitehub.payload.value",
  "vitehub.payload.visibility",
])
const CLAIM_LEASE_MS = 30_000
const CLAIM_RENEW_INTERVAL_MS = 10_000
const TERMINAL_RETRY_INTERVAL_MS = 1_000
const TERMINAL_RETRY_TIMEOUT_MS = 60_000
const STORE_OPERATION_TIMEOUT_MS = 1_000
const storeOperationTimedOut = Symbol("vitehub.storeOperationTimedOut")

export type AgentInvocationAnnotationValue = boolean | number | string | null
export type AgentInvocationRecordStatus = AgentInvocationStatus

export interface AgentInvocationRecord {
  agentName?: string
  annotations?: Record<string, AgentInvocationAnnotationValue>
  /** Capability IDs observed during this Invocation, including uses omitted from a truncated trace. */
  capabilityIds?: readonly string[]
  cancelledAt?: string
  channelId?: string
  completedAt?: string
  createdAt: string
  cursor: string
  error?: RuntimeDiagnosticError
  failedAt?: string
  id: string
  observations: readonly TraceEventLogEntry[]
  /** Resolved retention limits for this durable Invocation. */
  observationLimits?: Required<AgentInvocationObservationOptions>
  /** True when the journal dropped one or more observations. */
  observationsTruncated?: boolean
  origin?: string
  startedAt?: string
  status: AgentInvocationRecordStatus
  threadId?: string
  /** A bounded title projected from retained public title observations. */
  title?: string
  /** Sequence of the projected title, preserved when its observation is evicted. */
  titleSequence?: number
  traceId: string
  updatedAt: string
}

export interface AgentInvocationListOptions {
  agentName?: string
  capabilityId?: string
  cursor?: string
  limit?: number
  search?: string
  status?: AgentInvocationRecordStatus | readonly AgentInvocationRecordStatus[]
}

export type AgentInvocationSummary = Omit<AgentInvocationRecord, "observations">

export interface AgentInvocationListResult {
  cursor?: string
  invocations: readonly AgentInvocationSummary[]
  remainingStatuses?: readonly AgentInvocationRecordStatus[]
}

export type AgentInvocationStoreCreateInput = Omit<AgentInvocationRecord, "cursor">

export interface AgentInvocationStoreCreateResult {
  created: boolean
  record: AgentInvocationRecord
}

export interface AgentInvocationStoreUpdateInput {
  /** Append with a stable observation identity and a sequence assigned atomically by the store. */
  appendObservation?: Omit<TraceEventLogEntry, "sequence">
  annotations?: AgentInvocationRecord["annotations"]
  capabilityIds?: readonly string[]
  error?: AgentInvocationRecord["error"]
  observation?: TraceEventLogEntry
  observationsTruncated?: boolean
  status?: AgentInvocationRecordStatus
  timestamp: string
}

export interface AgentInvocationStore {
  claim(id: string, claimId: string, leaseMs: number, options?: {
    replaceClaimToken?: string
    replaceExisting?: boolean
  }): MaybePromise<boolean>
  create(input: AgentInvocationStoreCreateInput): MaybePromise<AgentInvocationStoreCreateResult>
  get(id: string): MaybePromise<AgentInvocationRecord | undefined>
  /** Reads invocation metadata without observation payloads. */
  getSummary(id: string): MaybePromise<AgentInvocationSummary | undefined>
  getClaimToken(id: string): MaybePromise<string | undefined>
  list(options?: AgentInvocationListOptions): MaybePromise<AgentInvocationListResult>
  listAgentNames?(): MaybePromise<readonly string[]>
  listCapabilityIds?(agentName?: string): MaybePromise<readonly string[]>
  release(id: string, claimId: string): MaybePromise<void>
  /** Updates are idempotent for observations carrying the ViteHub observation identity attribute. */
  update(id: string, input: AgentInvocationStoreUpdateInput, claimId?: string): MaybePromise<AgentInvocationRecord | undefined>
}

export interface AgentInvocationObservationOptions {
  /** Retained observations, including lifecycle outcomes. Default 256; maximum 8192. */
  maxCount?: number
  /** Maximum content string length in UTF-16 code units. Default 65536; maximum 1048576. */
  maxStringLength?: number
  /** Maximum UTF-8 bytes of the serialized observations array. Default 16 MiB; maximum 64 MiB. */
  maxBytes?: number
  /** Time to drain queued observations before terminal recovery. Default 1000 ms; maximum 60000 ms. */
  flushTimeoutMs?: number
}

const defaultObservationLimits = {
  maxCount: MAX_OBSERVATIONS,
  maxStringLength: MAX_OBSERVATION_CONTENT_STRING_LENGTH,
  maxBytes: DEFAULT_OBSERVATION_BYTES,
  flushTimeoutMs: STORE_OPERATION_TIMEOUT_MS,
} satisfies Required<AgentInvocationObservationOptions>

export function observationLimits(options: AgentInvocationObservationOptions = {}): Required<AgentInvocationObservationOptions> {
  const limits = { ...defaultObservationLimits }
  const maximum = { maxCount: 8192, maxStringLength: 1024 * 1024, maxBytes: 64 * 1024 * 1024, flushTimeoutMs: 60_000 }
  for (const key of ["maxCount", "maxStringLength", "maxBytes", "flushTimeoutMs"] as const) {
    const value = options[key]
    if (value === undefined) continue
    const minimum = key === "maxBytes" ? 2 : 1
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum[key]) {
      throw agentDiagnostics.AGENT_R0907({ message: `[vitehub] Agent Invocation observations.${key} must be an integer between ${minimum} and ${maximum[key]}.` })
    }
    limits[key] = value
  }
  return limits
}

export interface AgentInvocationsOptions {
  /** Retain resolved instructions and tool contracts independently of other trace content. Defaults to metadata. */
  configuration?: TraceEventContentPolicy
  content?: TraceEventContentPolicy
  metadataContent?: readonly string[]
  observations?: AgentInvocationObservationOptions
  store: AgentInvocationStore
}

export interface AgentInvocations {
  /** Durably append evidence to a live or terminal invocation. Repeated IDs return the existing observation. */
  appendObservation(id: string, event: TraceEvent, options: { id: string }): Promise<AgentInvocationRecord | undefined>
  readonly [agentInvocationsBrand]: true
  get(id: string): Promise<AgentInvocationRecord | undefined>
  getByRunId(runId: string, agentName?: string): Promise<AgentInvocationRecord | undefined>
  /** Reads invocation metadata without observation payloads. */
  getSummary(id: string): Promise<AgentInvocationSummary | undefined>
  list(options?: AgentInvocationListOptions): Promise<AgentInvocationListResult>
  listAgentNames(): Promise<readonly string[]>
  listCapabilityIds(agentName?: string): Promise<readonly string[]>
}

interface BoundAgentInvocations extends AgentInvocations {
  [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
    context: AgentRuntimeContext<TRuntimeConfig>,
    options?: { agentName?: string, deferClaim?: boolean, terminalTakeover?: boolean },
  ): Promise<AgentInvocationJournal<TRuntimeConfig>>
}

export interface AgentInvocationJournal<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  configuration?: TraceEventContentPolicy
  context: AgentRuntimeContext<TRuntimeConfig>
  finish(status: Extract<AgentInvocationRecordStatus, "completed" | "failed" | "cancelled">, error?: unknown): Promise<void>
  running(): Promise<void>
  setAnnotations(annotations: AgentRunMetadata["annotations"]): Promise<void>
}

function cloneObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  return {
    ...observation,
    ...(observation.activity ? { activity: { ...observation.activity } } : {}),
    ...(observation.attributes ? { attributes: structuredClone(observation.attributes) } : {}),
    ...(observation.payload ? { payload: structuredClone(observation.payload) } : {}),
    ...(observation.trace ? { trace: { ...observation.trace } } : {}),
  }
}

function observationIdentity(observation: TraceEventLogEntry): string | undefined {
  const identity = observation.attributes?.[AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE]
  return hasRuntimeType(identity, "string") ? identity : undefined
}

function sameObservation(left: TraceEventLogEntry, right: TraceEventLogEntry): boolean {
  if (left === right) return true
  const leftIdentity = observationIdentity(left)
  const rightIdentity = observationIdentity(right)
  return leftIdentity !== undefined && rightIdentity !== undefined && leftIdentity === rightIdentity
}

function observationPersistenceKey(observation: TraceEventLogEntry): string | number {
  return observationIdentity(observation) ?? observation.sequence
}

function cloneSummary(record: AgentInvocationRecord): AgentInvocationSummary {
  const { observations: _observations, ...summary } = record
  return {
    ...summary,
    ...(record.annotations ? { annotations: { ...record.annotations } } : {}),
    ...(record.capabilityIds ? { capabilityIds: [...record.capabilityIds] } : {}),
    ...(record.observationLimits ? { observationLimits: { ...record.observationLimits } } : {}),
    ...(record.error ? { error: structuredClone(record.error) } : {}),
  }
}

function cloneRecord(record: AgentInvocationRecord): AgentInvocationRecord {
  return {
    ...cloneSummary(record),
    observations: record.observations.map(cloneObservation),
  }
}

function normalizedCapabilityId(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "string")) return
  const capabilityId = boundedString(value.trim())
  return capabilityId || undefined
}

function observationCapabilityId(observation: TraceEventLogEntry | undefined): string | undefined {
  return normalizedCapabilityId(observation?.attributes?.["capability.id"])
}

function invocationCapabilityIds(record: Pick<AgentInvocationRecord, "capabilityIds" | "observations">): string[] {
  const capabilityIds = new Set<string>()
  for (const value of record.capabilityIds || []) {
    const capabilityId = normalizedCapabilityId(value)
    if (capabilityId) capabilityIds.add(capabilityId)
    if (capabilityIds.size >= MAX_CAPABILITY_IDS) return [...capabilityIds]
  }
  for (const observation of record.observations) {
    const capabilityId = observationCapabilityId(observation)
    if (capabilityId) capabilityIds.add(capabilityId)
    if (capabilityIds.size >= MAX_CAPABILITY_IDS) break
  }
  return [...capabilityIds]
}

async function boundedStoreOperation<T>(
  operation: () => MaybePromise<T>,
  timeoutMs = STORE_OPERATION_TIMEOUT_MS,
): Promise<T | undefined | typeof storeOperationTimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<typeof storeOperationTimedOut>((resolve) => {
        timer = setTimeout(() => resolve(storeOperationTimedOut), timeoutMs)
      }),
    ])
  }
  catch {
    return undefined
  }
  finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function annotationKey(key: string): boolean {
  return key.length <= MAX_ANNOTATION_KEY_LENGTH && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && hasRuntimeType(value, "object") && !Array.isArray(value)
}

function normalizeAnnotations(input: AgentRunMetadata["annotations"]): Record<string, AgentInvocationAnnotationValue> | undefined {
  if (!input || !hasRuntimeType(input, "object")) return
  const annotations: Record<string, AgentInvocationAnnotationValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(annotations).length >= MAX_ANNOTATIONS) break
    if (!annotationKey(key)) continue
    if (hasRuntimeType(value, "string")) annotations[key] = value.slice(0, MAX_ANNOTATION_STRING_LENGTH)
    else if (hasRuntimeType(value, "number") && Number.isFinite(value)) annotations[key] = value
    else if (hasRuntimeType(value, "boolean") || value === null) annotations[key] = value
  }
  return Object.keys(annotations).length ? annotations : undefined
}

function configurationAnnotations(
  observation: TraceEventLogEntry,
): Record<string, AgentInvocationAnnotationValue> | undefined {
  if (observation.name !== "vitehub.agent.configured") return
  const configuration = observation.attributes?.["vitehub.agent.configuration"]
  if (!isStringRecord(configuration)) return
  const driver = configuration.driver
  if (!isStringRecord(driver)) return
  const modelRecord = isStringRecord(driver.model) ? driver.model : undefined
  const provider = hasRuntimeType(modelRecord?.provider, "string")
    ? modelRecord.provider
    : hasRuntimeType(driver.provider, "string")
      ? driver.provider
      : undefined
  const modelId = hasRuntimeType(modelRecord?.id, "string")
    ? modelRecord.id
    : undefined
  const annotations: AgentRunMetadata["annotations"] = {}
  if (modelId) annotations["agent.model.id"] = modelId
  if (provider) annotations["agent.model.provider"] = provider
  return normalizeAnnotations(annotations)
}

function mergeConfigurationAnnotations(
  annotations: AgentInvocationRecord["annotations"],
  configured: Record<string, AgentInvocationAnnotationValue>,
): Record<string, AgentInvocationAnnotationValue> | undefined {
  const merged: Record<string, AgentInvocationAnnotationValue> = { ...configured }
  for (const [key, value] of Object.entries(annotations || {})) {
    if (!Object.hasOwn(configured, key)) merged[key] = value
  }
  return normalizeAnnotations(merged)
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw agentDiagnostics.AGENT_R0618({ message: "[vitehub] Agent Invocation list limit must be a positive integer." })
  }
  return Math.min(limit, MAX_LIST_LIMIT)
}

function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return
  if (!hasRuntimeType(search, "string")) {
    throw agentDiagnostics.AGENT_R0619({ message: "[vitehub] Agent Invocation search must be a string." })
  }
  const value = search.trim()
  if (!value) return
  if (value.length > 256) {
    throw agentDiagnostics.AGENT_R0620({ message: "[vitehub] Agent Invocation search must be at most 256 characters." })
  }
  return value
}

function matchesInvocationSearch(record: AgentInvocationRecord, search: string | undefined): boolean {
  if (!search) return true
  return searchableAgentInvocationText(record).includes(search.toLowerCase())
}

function normalizeBuiltInCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== cursor) {
    throw agentDiagnostics.AGENT_R0621({ message: "[vitehub] Agent Invocation cursor is invalid." })
  }
  return cursor
}

function boundedString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_METADATA_STRING_LENGTH)
}

function normalizedTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString()
}

interface ObservationBudget {
  items: number
  maxDepth?: number
  collectionItems?: number
  stringLength: number
  truncated: boolean
}

interface BoundedObservationBuiltIn {
  truncated: boolean
  value: unknown
}

function boxedObservationPrimitive(value: unknown): { type: string, value: bigint | boolean | number | string } | undefined {
  if (!value || !hasRuntimeType(value, "object")) return
  for (const [type, unwrap] of [
    ["Boolean", () => Boolean.prototype.valueOf.call(value)],
    ["Number", () => Number.prototype.valueOf.call(value)],
    ["String", () => String.prototype.valueOf.call(value)],
    ["BigInt", () => BigInt.prototype.valueOf.call(value)],
  ] as const) {
    try {
      return { type, value: unwrap() }
    }
    catch {
      // Try the next intrinsic wrapper.
    }
  }
}

async function collectBoundedObservationBuiltIns(
  value: unknown,
  builtIns: Map<object, BoundedObservationBuiltIn>,
  budget: { items: number },
  seen = new Set<object>(),
  depth = 0,
): Promise<void> {
  if (!value || !hasRuntimeType(value, "object") || seen.has(value) || budget.items <= 0 || depth >= MAX_OBSERVATION_DEPTH) return
  budget.items--
  seen.add(value)
  const BlobConstructor = globalThis.Blob
  if (hasRuntimeType(BlobConstructor, "function") && value instanceof BlobConstructor) {
    const FileConstructor = globalThis.File
    const file = hasRuntimeType(FileConstructor, "function") && value instanceof FileConstructor ? value : undefined
    const bytes = Array.from(new Uint8Array(await value.slice(0, MAX_OBSERVATION_COLLECTION_ITEMS).arrayBuffer()))
    const representation: Record<string, unknown> = {
      bytes,
      mediaType: value.type,
      size: value.size,
      type: file ? "File" : "Blob",
    }
    if (file) {
      representation.lastModified = file.lastModified
      representation.name = file.name
    }
    builtIns.set(value, {
      truncated: true,
      value: representation,
    })
    return
  }
  const primitive = boxedObservationPrimitive(value)
  if (primitive) {
    builtIns.set(value, { truncated: true, value: primitive })
    return
  }
  if (Array.isArray(value)) {
    const length = Math.min(value.length, MAX_OBSERVATION_COLLECTION_ITEMS, budget.items)
    for (let index = 0; index < length; index++) {
      if (Object.hasOwn(value, index)) await collectBoundedObservationBuiltIns(value[index], builtIns, budget, seen, depth + 1)
    }
    return
  }
  if (value instanceof Map) {
    let count = 0
    for (const [key, child] of value) {
      if (count++ >= MAX_OBSERVATION_COLLECTION_ITEMS) break
      await collectBoundedObservationBuiltIns(key, builtIns, budget, seen, depth + 1)
      await collectBoundedObservationBuiltIns(child, builtIns, budget, seen, depth + 1)
    }
    return
  }
  if (value instanceof Set) {
    let count = 0
    for (const child of value) {
      if (count++ >= MAX_OBSERVATION_COLLECTION_ITEMS) break
      await collectBoundedObservationBuiltIns(child, builtIns, budget, seen, depth + 1)
    }
    return
  }
  if (value instanceof Error) {
    if (value instanceof AggregateError) {
      await collectBoundedObservationBuiltIns(value.errors, builtIns, budget, seen, depth + 1)
    }
    if (Object.hasOwn(value, "cause")) {
      await collectBoundedObservationBuiltIns(value.cause, builtIns, budget, seen, depth + 1)
    }
    for (const [key, child] of Object.entries(value).slice(0, MAX_OBSERVATION_COLLECTION_ITEMS)) {
      if (key !== "cause" && key !== "errors") {
        await collectBoundedObservationBuiltIns(child, builtIns, budget, seen, depth + 1)
      }
    }
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return
  for (const child of Object.values(value).slice(0, MAX_OBSERVATION_COLLECTION_ITEMS)) {
    await collectBoundedObservationBuiltIns(child, builtIns, budget, seen, depth + 1)
  }
}

function boundedObservationValue(
  value: unknown,
  budget: ObservationBudget,
  depth = 0,
  maxStringLength = MAX_METADATA_STRING_LENGTH,
  builtIns?: ReadonlyMap<object, BoundedObservationBuiltIn>,
): unknown {
  if (value && hasRuntimeType(value, "object")) {
    const builtIn = builtIns?.get(value)
    if (builtIn) {
      if (builtIn.truncated) budget.truncated = true
      value = builtIn.value
    }
  }
  if (budget.items <= 0) {
    budget.truncated = true
    return "[truncated]"
  }
  budget.items--
  if (value === undefined) {
    budget.truncated = true
    return null
  }
  if (hasRuntimeType(value, "string")) {
    if (budget.stringLength <= 0) {
      budget.truncated = true
      return "[truncated]"
    }
    const length = Math.min(value.length, maxStringLength, budget.stringLength)
    if (length < value.length) budget.truncated = true
    budget.stringLength -= length
    return value.slice(0, length)
  }
  if (value === null || hasRuntimeType(value, "boolean")) return value
  if (hasRuntimeType(value, "number")) {
    if (!Number.isFinite(value) || Object.is(value, -0)) budget.truncated = true
    return Number.isFinite(value) ? value : null
  }
  if (hasRuntimeType(value, "bigint")) {
    budget.truncated = true
    const string = String(value)
    if (string.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
    return boundedString(string)
  }
  if (depth >= (budget.maxDepth ?? MAX_OBSERVATION_DEPTH)) {
    budget.truncated = true
    return "[truncated]"
  }
  if (Array.isArray(value)) {
    const length = Math.min(value.length, (budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
    if (length < value.length) budget.truncated = true
    return Array.from({ length }, (_, index) => {
      if (!Object.hasOwn(value, index)) {
        budget.truncated = true
        return boundedObservationValue(undefined, budget, depth + 1, maxStringLength, builtIns)
      }
      return boundedObservationValue(value[index], budget, depth + 1, maxStringLength, builtIns)
    })
  }
  if (value instanceof Date) {
    budget.truncated = true
    return {
      type: "Date",
      value: boundedObservationValue(
        Number.isFinite(value.getTime()) ? value.toISOString() : String(value),
        budget,
        depth + 1,
        maxStringLength,
        builtIns,
      ),
    }
  }
  if (value instanceof Map) {
    budget.truncated = true
    const entries: [unknown, unknown][] = []
    const limit = Math.min((budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
    for (const entry of value) {
      if (entries.length >= limit) break
      entries.push(entry)
    }
    if (entries.length < value.size) budget.truncated = true
    return entries.map(([key, child]) => [
      boundedObservationValue(key, budget, depth + 1, maxStringLength, builtIns),
      boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns),
    ])
  }
  if (value instanceof Set) {
    budget.truncated = true
    const entries: unknown[] = []
    const limit = Math.min((budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
    for (const entry of value) {
      if (entries.length >= limit) break
      entries.push(entry)
    }
    if (entries.length < value.size) budget.truncated = true
    return entries.map(child => boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns))
  }
  if (value instanceof ArrayBuffer) {
    budget.truncated = true
    const length = Math.min(value.byteLength, (budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
    return boundedObservationValue(Array.from(new Uint8Array(value, 0, length)), budget, depth + 1, maxStringLength, builtIns)
  }
  if (ArrayBuffer.isView(value)) {
    budget.truncated = true
    const length = Math.min(value.byteLength, (budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
    return {
      bytes: boundedObservationValue(
        Array.from(new Uint8Array(value.buffer, value.byteOffset, length)),
        budget,
        depth + 1,
        maxStringLength,
        builtIns,
      ),
      type: value.constructor.name,
    }
  }
  if (value instanceof RegExp) {
    budget.truncated = true
    return {
      flags: boundedObservationValue(value.flags, budget, depth + 1, maxStringLength, builtIns),
      lastIndex: boundedObservationValue(value.lastIndex, budget, depth + 1, maxStringLength, builtIns),
      source: boundedObservationValue(value.source, budget, depth + 1, maxStringLength, builtIns),
    }
  }
  if (value instanceof Error) {
    budget.truncated = true
    const details: Array<[string, unknown]> = [
      ["name", value.name],
      ["message", value.message],
    ]
    if (value instanceof AggregateError) details.push(["errors", value.errors])
    if (Object.hasOwn(value, "cause")) details.push(["cause", value.cause])
    for (const [key, child] of Object.entries(value)) {
      if (key !== "cause" && key !== "errors") details.push([key, child])
    }
    const length = Math.min(details.length, (budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS))
    if (length < details.length) budget.truncated = true
    return Object.fromEntries(details.slice(0, length).map(([key, child]) => [
      boundedString(key),
      boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns),
    ]))
  }
  if (!value || !hasRuntimeType(value, "object")) {
    const string = String(value)
    if (string.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
    return boundedString(string)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    budget.truncated = true
    return `[unsupported ${Object.prototype.toString.call(value).slice(8, -1)}]`
  }
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const entries = Object.entries(value as Record<string, unknown>)
  const length = Math.min(entries.length, (budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS), budget.items)
  if (length < entries.length) budget.truncated = true
  return Object.fromEntries(entries
    .slice(0, length)
    .flatMap(([key, child]) => {
      if (key.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
      return [[boundedString(key), boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns)]]
    }))
}

function boundedObservationPayload(
  payload: TraceEventPayload | undefined,
  budget: ObservationBudget,
  builtIns?: ReadonlyMap<object, BoundedObservationBuiltIn>,
): TraceEventPayload | undefined {
  if (payload?.visibility === "public") {
    return { value: boundedObservationValue(payload.value, budget, 0, budget.stringLength, builtIns), visibility: "public" }
  }
  if (payload?.visibility === "summary") {
    if (payload.summary.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
    return { summary: boundedString(payload.summary)!, visibility: "summary" }
  }
  if (payload?.visibility === "redacted") return { visibility: "redacted" }
  if (payload?.visibility === "private") return { visibility: "private" }
}

function boundedObservationAttributeValue(
  key: string,
  value: unknown,
  budget: ObservationBudget,
  maxStringLength: number,
  builtIns?: ReadonlyMap<object, BoundedObservationBuiltIn>,
): unknown {
  if (key !== "vitehub.agent.configuration") return boundedObservationValue(value, budget, 0, maxStringLength, builtIns)
  const configurationBudget: ObservationBudget = {
    items: 16_384,
    collectionItems: MAX_CAPABILITY_IDS,
    maxDepth: MAX_AGENT_CONFIGURATION_DEPTH,
    stringLength: budget.stringLength,
    truncated: false,
  }
  const configuration = boundedObservationValue(value, configurationBudget, 0, maxStringLength, builtIns)
  budget.stringLength = configurationBudget.stringLength
  budget.truncated ||= configurationBudget.truncated
  return configuration
}

function boundedObservation(
  observation: TraceEventLogEntry,
  builtIns?: ReadonlyMap<object, BoundedObservationBuiltIn>,
  limits = defaultObservationLimits,
): TraceEventLogEntry {
  const budget: ObservationBudget = {
    items: MAX_OBSERVATION_VALUE_ITEMS,
    stringLength: limits.maxStringLength,
    truncated: false,
  }
  const identity = observationIdentity(observation)
  const payloadBudget: ObservationBudget = {
    items: MAX_OBSERVATION_VALUE_ITEMS,
    stringLength: limits.maxStringLength,
    truncated: false,
  }
  const payload = boundedObservationPayload(observation.payload, payloadBudget, builtIns)
  const canonicalAttributes: Record<string, unknown> = {}
  if (identity !== undefined) canonicalAttributes[AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE] = identity
  if (observation.attributes?.[APPENDED_OBSERVATION_ATTRIBUTE] === true) canonicalAttributes[APPENDED_OBSERVATION_ATTRIBUTE] = true
  if (observation.activity) {
    canonicalAttributes["vitehub.activity.owner"] = observation.activity.owner
    canonicalAttributes["vitehub.activity.phase"] = observation.activity.phase
  }
  if (payload) {
    canonicalAttributes["vitehub.payload.visibility"] = payload.visibility
    if (payload.visibility === "public") canonicalAttributes["vitehub.payload.value"] = payload.value
    if (payload.visibility === "summary") canonicalAttributes["vitehub.payload.summary"] = payload.summary
  }
  const ordinaryAttributes = Object.entries(observation.attributes || {})
    .filter(([key]) => !CANONICAL_TRACE_ATTRIBUTE_KEYS.has(key))
  const ordinaryAttributeLimit = MAX_OBSERVATION_ATTRIBUTES - Object.keys(canonicalAttributes).length
  if (ordinaryAttributes.length > ordinaryAttributeLimit) {
    budget.truncated = true
  }
  let attributes = observation.attributes || Object.keys(canonicalAttributes).length
    ? {
        ...Object.fromEntries(ordinaryAttributes
          .slice(0, ordinaryAttributeLimit)
        .flatMap(([key, value]) => {
          if (key.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
          return value === undefined ? [] : [[boundedString(key), boundedObservationAttributeValue(
            key,
            value,
            budget,
            isTraceContentAttributeKey(key) ? limits.maxStringLength : MAX_METADATA_STRING_LENGTH,
            builtIns,
          )]]
        })),
        ...canonicalAttributes,
      }
    : undefined
  if (payloadBudget.truncated) budget.truncated = true
  if (budget.truncated) {
    attributes ||= {}
    if (Object.keys(attributes).length >= MAX_OBSERVATION_ATTRIBUTES) {
      const lastOrdinaryAttribute = Object.keys(attributes)
        .filter(key => !CANONICAL_TRACE_ATTRIBUTE_KEYS.has(key))
        .at(-1)
      if (lastOrdinaryAttribute) delete attributes[lastOrdinaryAttribute]
    }
    if (observation.name === "vitehub.agent.configured") {
      attributes["vitehub.agent.configurationTruncated"] = true
    }
    else {
      attributes[AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE] = true
    }
  }
  return {
    ...observation,
    name: boundedString(observation.name)!,
    timestamp: normalizedTimestamp(observation.timestamp),
    ...(attributes ? { attributes } : {}),
    ...(payload ? { payload } : {}),
    ...(observation.trace
      ? { trace: {
          ...observation.trace,
          id: boundedString(observation.trace.id)!,
          ...(observation.trace.parentId ? { parentId: boundedString(observation.trace.parentId) } : {}),
        } }
      : {}),
  }
}

async function boundedJournalObservation(observation: TraceEventLogEntry, limits = defaultObservationLimits): Promise<TraceEventLogEntry> {
  const builtIns = new Map<object, BoundedObservationBuiltIn>()
  await collectBoundedObservationBuiltIns(observation.attributes, builtIns, { items: MAX_OBSERVATION_VALUE_ITEMS })
  await collectBoundedObservationBuiltIns(observation.payload, builtIns, { items: MAX_OBSERVATION_VALUE_ITEMS })
  return boundedObservation(observation, builtIns, limits)
}

async function boundedIdentity(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}

function invocationIdentity(runId: string, agentName?: string): string {
  return JSON.stringify([agentName ?? null, runId])
}

function assertInvocationId(id: string): void {
  if (!hasRuntimeType(id, "string") || !id.trim()) {
    throw agentDiagnostics.AGENT_R0622({ message: "[vitehub] Agent Invocations require a non-empty invocation id." })
  }
}

export async function agentInvocationId(runId: string, agentName?: string): Promise<string> {
  assertInvocationId(runId)
  return await boundedIdentity(invocationIdentity(runId, agentName))
}

function assertStore(store: AgentInvocationStore | undefined): asserts store is AgentInvocationStore {
  if (!store
    || !hasRuntimeType(store.claim, "function")
    || !hasRuntimeType(store.create, "function")
    || !hasRuntimeType(store.get, "function")
    || !hasRuntimeType(store.getSummary, "function")
    || !hasRuntimeType(store.getClaimToken, "function")
    || !hasRuntimeType(store.list, "function")
    || !hasRuntimeType(store.release, "function")
    || !hasRuntimeType(store.update, "function")) {
    throw agentDiagnostics.AGENT_R0623({ message: "[vitehub] Agent Invocations require a store with claim(), create(), get(), getSummary(), getClaimToken(), list(), release(), and update()." })
  }
}

function errorDetails(error: unknown): AgentInvocationRecord["error"] | undefined {
  if (error === undefined) return
  return normalizeRuntimeDiagnosticError(error, { maxDepth: 4, maxErrors: 8, maxStringLength: MAX_METADATA_STRING_LENGTH })
}

function terminalStatus(status: AgentInvocationRecordStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function terminalObservation(observation: TraceEventLogEntry): boolean {
  return observation.name === "agent.invocation.finish"
    || observation.name === "agent.invocation.error"
    || observation.name === "agent.invocation.cancelled"
    || observation.name === "run.finish"
    || observation.name === "run.error"
}

function failureEvidenceObservation(observation: TraceEventLogEntry): boolean {
  return observation.name === "run.error"
    || (observation.name === "agent.stream.error" && observation.attributes?.["error.recoverable"] !== true)
}

function deliveryOutcomeObservation(observation: TraceEventLogEntry): boolean {
  return observation.name === "agent.channel.delivery.effect"
}

function observationTitle(observation: TraceEventLogEntry | undefined): string | undefined {
  if (observation?.name !== "agent.title.recorded") return
  const value = observation.attributes?.["vitehub.session.title"]
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Trace attributes are unknown; a title is a trimmed, bounded string and all other values are omitted.
  if (typeof value !== "string") return
  return value.trim().slice(0, MAX_METADATA_STRING_LENGTH) || undefined
}

export function isAppendedObservation(observation: TraceEventLogEntry): boolean {
  return observation.attributes?.[APPENDED_OBSERVATION_ATTRIBUTE] === true
}

function outcomeObservationPriority(observation: TraceEventLogEntry): number | undefined {
  if (isAppendedObservation(observation)) return -1
  if (failureEvidenceObservation(observation)) return 0
  if (terminalObservation(observation)) return 1
  if (deliveryOutcomeObservation(observation)) return 2
  if (observationTitle(observation)) return 3
}

function recoverableOutcomeObservation(observation: TraceEventLogEntry): boolean {
  return deliveryOutcomeObservation(observation)
    || observationTitle(observation) !== undefined
    || (observationIdentity(observation) !== undefined && outcomeObservationPriority(observation) !== undefined)
}

function truncatedObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  return {
    ...observation,
    attributes: { ...observation.attributes, "vitehub.trace.truncated": true },
  }
}

function retainedPriorityOutcomes(
  observations: readonly TraceEventLogEntry[],
  limit: number,
): TraceEventLogEntry[] {
  if (limit <= 0) return []
  const identified = new Map<string, TraceEventLogEntry>()
  for (const observation of observations) {
    if (outcomeObservationPriority(observation) === undefined) continue
    const identity = observationIdentity(observation)
    if (identity !== undefined) identified.set(identity, observation)
  }
  const candidates = observations.filter((observation) => {
    if (outcomeObservationPriority(observation) === undefined) return false
    const identity = observationIdentity(observation)
    return identity === undefined || identified.get(identity) === observation
  })
  const hasLifecycleTerminal = candidates.some(observation => outcomeObservationPriority(observation) === 1)
  const retained: TraceEventLogEntry[] = []
  for (const priority of [-1, 0, 1, 2, 3]) {
    const remaining = limit - retained.length
    if (remaining === 0) break
    const available = priority === 0 && hasLifecycleTerminal ? Math.max(0, remaining - 1) : remaining
    const matching = candidates.filter(observation => outcomeObservationPriority(observation) === priority)
    if (available > 0) retained.push(...matching.slice(-available))
  }
  const candidateOrder = new Map(candidates.map((observation, index) => [observation, index]))
  return retained.sort((left, right) => left.sequence - right.sequence
    || (candidateOrder.get(left) ?? 0) - (candidateOrder.get(right) ?? 0))
}

function prioritizePendingOutcomes(
  pending: TraceEventLogEntry[],
  incoming: TraceEventLogEntry,
  active: TraceEventLogEntry | undefined,
  maxCount: number,
): void {
  const limit = maxCount - (active ? 1 : 0)
  const outcomes = retainedPriorityOutcomes([...pending, incoming], limit)
  const ordinary = pending.filter(observation => outcomeObservationPriority(observation) === undefined)
  const ordinaryLimit = Math.max(0, limit - outcomes.length)
  pending.splice(0, pending.length, ...outcomes, ...ordinary.slice(0, ordinaryLimit))
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // SAFETY: Node timers expose optional unref; browser timers are numbers and therefore have no method.
  const unref = (timer as { unref?: () => void }).unref
  if (unref) unref.call(timer)
}

// Bound encoded storage size after privacy filtering and value normalization.
export function byteBoundedObservations(values: readonly TraceEventLogEntry[], limits: Required<AgentInvocationObservationOptions>): { observations: readonly TraceEventLogEntry[], truncated: boolean } {
  const maxBytes = limits.maxBytes
  const encoder = new TextEncoder()
  let observations = values
  let serialized: string
  try {
    serialized = JSON.stringify(observations)
  }
  catch {
    // Custom stores can contain cloneable values such as BigInt and cycles.
    observations = values.map((observation) => {
      try { JSON.stringify(observation); return observation }
      catch { return boundedObservation(observation, undefined, limits) }
    })
    serialized = JSON.stringify(observations)
  }
  if (encoder.encode(serialized).byteLength <= maxBytes) return { observations, truncated: false }
  const sizes = new Map(observations.map(observation => [observation, encoder.encode(JSON.stringify(observation)).byteLength]))

  const priority = [...retainedPriorityOutcomes(observations, observations.length)]
    .sort((left, right) => outcomeObservationPriority(left)! - outcomeObservationPriority(right)! || right.sequence - left.sequence)
  const outcomes = new Set(priority)
  const candidates = [...priority, ...observations.filter(observation => !outcomes.has(observation))]
  const retained: TraceEventLogEntry[] = []
  let bytes = 2
  for (const observation of candidates) {
    let candidate = observation
    let size = sizes.get(observation)!
    if (bytes + size + (retained.length ? 1 : 0) > maxBytes && isAppendedObservation(observation)) {
      throw agentDiagnostics.AGENT_R0908({ message: "[vitehub] Agent Invocation observation byte capacity reached; appended evidence was not changed." })
    }
    if (bytes + size + (retained.length ? 1 : 0) > maxBytes && outcomes.has(observation)) {
      candidate = {
        ...observation,
        attributes: {
          ...Object.fromEntries(Object.entries(observation.attributes || {}).filter(([key]) => !isTraceContentAttributeKey(key) && key !== "vitehub.payload.value")),
          [AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true,
          ...(observation.payload?.visibility === "public" ? { "vitehub.payload.visibility": "redacted" } : {}),
        },
        ...(observation.payload?.visibility === "public" ? { payload: { visibility: "redacted" as const } } : {}),
      }
      size = encoder.encode(JSON.stringify(candidate)).byteLength
    }
    if (bytes + size + (retained.length ? 1 : 0) > maxBytes) continue
    bytes += size + (retained.length ? 1 : 0)
    retained.push(candidate)
  }
  return { observations: retained.sort((left, right) => left.sequence - right.sequence), truncated: true }
}

export function applyAgentInvocationStoreUpdate(
  record: AgentInvocationRecord,
  input: AgentInvocationStoreUpdateInput,
): AgentInvocationRecord {
  const isAppend = input.appendObservation !== undefined
  const limits = observationLimits(record.observationLimits)
  if (!isAppend && input.observation?.attributes?.[APPENDED_OBSERVATION_ATTRIBUTE] === true) {
    const attributes = { ...input.observation.attributes }
    delete attributes[APPENDED_OBSERVATION_ATTRIBUTE]
    input = { ...input, observation: { ...input.observation, attributes } }
  }
  if (input.appendObservation) {
    if (input.observation) throw agentDiagnostics.AGENT_R0898({ message: "[vitehub] Append and update observations cannot be combined." })
    const identity = observationIdentity({ ...input.appendObservation, sequence: 0 })
    if (!identity) throw agentDiagnostics.AGENT_R0899({ message: "[vitehub] Appended observations require a stable identity." })
    if (record.observations.some(observation => observationIdentity(observation) === identity)) return record
    if (record.observations.length >= limits.maxCount) {
      throw agentDiagnostics.AGENT_R0900({ message: "[vitehub] Agent Invocation observation capacity reached; evidence was not appended." })
    }
    input = {
      observation: {
        ...input.appendObservation,
        attributes: { ...input.appendObservation.attributes, [APPENDED_OBSERVATION_ATTRIBUTE]: true },
        sequence: record.observations.reduce((maximum, observation) => Math.max(maximum, observation.sequence), record.titleSequence ?? 0) + 1,
      },
      timestamp: input.timestamp,
    }
  }
  if (terminalStatus(record.status) && input.observation && !recoverableOutcomeObservation(input.observation)) return record
  if (terminalStatus(record.status) && !input.observation && !input.observationsTruncated) return record
  const incomingObservation = input.observation
  const duplicateObservation = incomingObservation !== undefined
    && record.observations.some(observation => sameObservation(observation, incomingObservation))
  const status = input.status && (!terminalStatus(record.status) || input.status === record.status)
    ? input.status
    : record.status
  const configuredAnnotations = input.observation
    ? configurationAnnotations(input.observation)
    : undefined
  const incomingTitle = observationTitle(input.observation)
  const latestTitleSequence = record.titleSequence ?? record.observations.reduce((latest, observation) =>
    observationTitle(observation) ? Math.max(latest, observation.sequence) : latest, -1)
  const titleUpdated = incomingTitle && input.observation && !duplicateObservation && input.observation.sequence > latestTitleSequence
  const title = titleUpdated
    ? incomingTitle
    : record.title
  const capabilityIds = invocationCapabilityIds(record)
  for (const value of [...(input.capabilityIds || []), observationCapabilityId(input.observation)]) {
    const incomingCapabilityId = normalizedCapabilityId(value)
    if (incomingCapabilityId && capabilityIds.length < MAX_CAPABILITY_IDS && !capabilityIds.includes(incomingCapabilityId)) {
      capabilityIds.push(incomingCapabilityId)
    }
  }
  const incoming = input.observation && !duplicateObservation
    ? cloneObservation(boundedObservation(input.observation, undefined, limits))
    : undefined
  if (incoming && record.observations.some(candidate => candidate.sequence === incoming.sequence)) {
    incoming.sequence = record.observations.reduce((maximum, candidate) => Math.max(maximum, candidate.sequence), record.titleSequence ?? 0) + 1
  }
  const observations = incoming
    ? record.observations.length < limits.maxCount
      ? (() => {
          const insertAt = record.observations.findIndex(candidate => candidate.sequence > incoming.sequence)
          return insertAt < 0
            ? [...record.observations, incoming]
            : [...record.observations.slice(0, insertAt), incoming, ...record.observations.slice(insertAt)]
        })()
      : (() => {
          const outcomes = retainedPriorityOutcomes(
            [...record.observations, incoming],
            limits.maxCount,
          )
          if (outcomes.length === 0) outcomes.push(record.observations.at(-1)!)
          const retainedOutcomeIdentities = new Set(outcomes.map(observationIdentity).filter(identity => identity !== undefined))
          const retained = record.observations.filter((observation) => {
            const identity = observationIdentity(observation)
            return identity === undefined ? !outcomes.includes(observation) : !retainedOutcomeIdentities.has(identity)
          })
          return [
            ...retained.slice(0, limits.maxCount - outcomes.length),
            ...outcomes.map(observation => isAppendedObservation(observation)
              ? cloneObservation(observation)
              : cloneObservation(boundedObservation(truncatedObservation(observation), undefined, limits))),
          ].sort((left, right) => left.sequence - right.sequence)
        })()
    : record.observations
  const retained = byteBoundedObservations(observations, limits)
  if (isAppend && retained.truncated) {
    throw agentDiagnostics.AGENT_R0909({ message: "[vitehub] Agent Invocation observation byte capacity reached; evidence was not appended." })
  }
  const updated: AgentInvocationRecord = {
    ...record,
    ...(configuredAnnotations
      ? { annotations: mergeConfigurationAnnotations(record.annotations, configuredAnnotations) }
      : {}),
    ...(capabilityIds.length ? { capabilityIds } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(title ? { title } : {}),
    ...(titleUpdated ? { titleSequence: input.observation!.sequence } : {}),
    observations: retained.observations,
    ...(retained.truncated || input.observationsTruncated || (input.observation && !duplicateObservation && record.observations.length >= limits.maxCount)
      ? { observationsTruncated: true }
      : {}),
    ...(status === "running" && !isAppend && !record.startedAt ? { startedAt: input.timestamp } : {}),
    ...(status === "completed" && !isAppend && !record.completedAt ? { completedAt: input.timestamp } : {}),
    ...(status === "failed" && !isAppend && !record.failedAt ? { failedAt: input.timestamp } : {}),
    ...(status === "cancelled" && !isAppend && !record.cancelledAt ? { cancelledAt: input.timestamp } : {}),
    status,
    updatedAt: input.timestamp > record.updatedAt ? input.timestamp : record.updatedAt,
  }
  if (Object.hasOwn(input, "annotations")) {
    const annotations = normalizeAnnotations(input.annotations)
    if (annotations) updated.annotations = annotations
    else delete updated.annotations
  }
  return updated
}

export function createMemoryAgentInvocationStore(): AgentInvocationStore {
  const claims = new Map<string, { claimId: string, expiresAt: number, token: string }>()
  const records = new Map<string, AgentInvocationRecord>()
  let cursor = 0
  return {
    claim(id, claimId, leaseMs, options) {
      const claim = claims.get(id)
      const now = Date.now()
      const replace = options?.replaceExisting
        || (options?.replaceClaimToken !== undefined && claim?.token === options.replaceClaimToken)
      if (!records.has(id) || (!replace && claim && claim.claimId !== claimId && claim.expiresAt > now)) return false
      claims.set(id, { claimId, expiresAt: now + leaseMs, token: globalThis.crypto.randomUUID() })
      return true
    },
    create(input) {
      const existing = records.get(input.id)
      if (existing) return { created: false, record: cloneRecord(existing) }
      const record = { ...input, cursor: String(++cursor) }
      records.set(record.id, cloneRecord(record))
      return { created: true, record: cloneRecord(record) }
    },
    get(id) {
      const record = records.get(id)
      return record ? cloneRecord(record) : undefined
    },
    getSummary(id) {
      const record = records.get(id)
      if (!record) return
      return cloneSummary(record)
    },
    getClaimToken(id) {
      return claims.get(id)?.token
    },
    list(options = {}) {
      const limit = normalizeLimit(options.limit)
      const cursor = normalizeBuiltInCursor(options.cursor)
      const search = normalizeSearch(options.search)
      const agentName = options.agentName?.trim()
      const capabilityId = options.capabilityId?.trim()
      const statuses = options.status === undefined
        ? undefined
        : new Set(Array.isArray(options.status) ? options.status : [options.status])
      const before = cursor === undefined ? Number.POSITIVE_INFINITY : Number(cursor)
      const candidates = [...records.values()]
        .filter(record => Number(record.cursor) < before
          && (!agentName || record.agentName === agentName)
          && (!capabilityId || invocationCapabilityIds(record).includes(capabilityId))
          && (!statuses || statuses.has(record.status))
          && matchesInvocationSearch(record, search))
        .sort((a, b) => Number(b.cursor) - Number(a.cursor))
      const page = candidates.slice(0, limit)
      return {
        ...(candidates.length > limit && page.length ? { cursor: page.at(-1)!.cursor } : {}),
        invocations: page.map(cloneSummary),
      }
    },
    listAgentNames() {
      return [...new Set([...records.values()].flatMap(record => record.agentName?.trim() || []))]
        .sort()
    },
    listCapabilityIds(agentName) {
      const selectedAgent = agentName?.trim()
      return [...new Set([...records.values()]
        .filter(record => !selectedAgent || record.agentName === selectedAgent)
        .flatMap(record => invocationCapabilityIds(record)))]
        .sort()
    },
    release(id, claimId) {
      if (claims.get(id)?.claimId === claimId) claims.delete(id)
    },
    update(id, input, claimId) {
      const record = records.get(id)
      if (!record || (claimId && claims.get(id)?.claimId !== claimId)) return
      const updated = applyAgentInvocationStoreUpdate(record, input)
      records.set(id, cloneRecord(updated))
      return cloneRecord(updated)
    },
  }
}

function createInvocationId(): string {
  return `ainv_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`
}

function captureMetadataContentValues(event: TraceEvent, keys: ReadonlySet<string>): Map<string, unknown> {
  const values = new Map<string, unknown>()
  for (const key of keys) {
    try {
      const attributes = event.attributes
      if (!attributes) continue
      const descriptor = Object.getOwnPropertyDescriptor(attributes, key)
      if (descriptor && "value" in descriptor) {
        const snapshot = structuredClone(descriptor.value)
        if (snapshot !== undefined) values.set(key, snapshot)
      }
    }
    catch {}
  }
  return values
}

function restoreMetadataContentValues(entry: TraceEventLogEntry, values: ReadonlyMap<string, unknown>): void {
  if (!entry.attributes) return
  const omitted = Array.isArray(entry.attributes["content.omitted"])
    ? entry.attributes["content.omitted"].filter(key => !values.has(String(key)))
    : undefined
  for (const [key, value] of values) entry.attributes[key] = value
  if (omitted?.length) entry.attributes["content.omitted"] = omitted
  else delete entry.attributes["content.omitted"]
}

function journalTraceLog(
  traceLog: TraceEventLog,
  observe: (entry: TraceEventLogEntry) => void,
  nextSequence: () => number,
  content: TraceEventContentPolicy,
  metadataContent: ReadonlySet<string>,
): TraceEventLog {
  const journalId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const messageDeltaChunkCharacters = MAX_METADATA_STRING_LENGTH
  const messageDeltaChunkEvents = 32
  let pendingMessageDelta: TraceEventLogEntry | undefined
  let pendingMessageDeltaEvents = 0
  const emit = (entry: TraceEventLogEntry) => {
    const sequence = nextSequence()
    const identity = outcomeObservationPriority(entry) !== undefined
      ? { [AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE]: `${journalId}:${sequence}` }
      : undefined
    void observe({
      ...entry,
      ...((entry.attributes || identity) ? { attributes: { ...entry.attributes, ...identity } } : {}),
      sequence,
    })
  }
  const flushMessageDelta = () => {
    if (!pendingMessageDelta) return
    emit(pendingMessageDelta)
    pendingMessageDelta = undefined
    pendingMessageDeltaEvents = 0
  }
  const queueMessageDelta = (entry: TraceEventLogEntry) => {
    const rawContent = entry.attributes?.["message.content"]
    const content = Object.prototype.toString.call(rawContent) === "[object String]" ? String(rawContent) : undefined
    if (content && content.length > messageDeltaChunkCharacters) {
      for (let offset = 0; offset < content.length; offset += messageDeltaChunkCharacters) {
        queueMessageDelta({
          ...entry,
          attributes: {
            ...entry.attributes,
            "message.content": content.slice(offset, offset + messageDeltaChunkCharacters),
          },
        })
      }
      return
    }
    const pending = pendingMessageDelta
    const rawPreviousContent = pending?.attributes?.["message.content"]
    const previousContent = Object.prototype.toString.call(rawPreviousContent) === "[object String]"
      ? String(rawPreviousContent)
      : undefined
    const sameMessage = pending
      && pending.attributes?.["message.id"] === entry.attributes?.["message.id"]
      && pending.attributes?.["message.phase"] === entry.attributes?.["message.phase"]
      && pending.attributes?.["message.role"] === entry.attributes?.["message.role"]
    if (sameMessage && (previousContent === undefined) === (content === undefined)) {
      if (previousContent !== undefined && content !== undefined
        && previousContent.length + content.length > messageDeltaChunkCharacters) {
        const available = messageDeltaChunkCharacters - previousContent.length
        queueMessageDelta({
          ...entry,
          attributes: { ...entry.attributes, "message.content": content.slice(0, available) },
        })
        queueMessageDelta({
          ...entry,
          attributes: { ...entry.attributes, "message.content": content.slice(available) },
        })
        return
      }
      const attributes = { ...pending.attributes, ...entry.attributes }
      if (previousContent !== undefined && content !== undefined) {
        attributes["message.content"] = `${previousContent}${content}`
      }
      pendingMessageDelta = { ...entry, attributes }
    }
    else {
      flushMessageDelta()
      pendingMessageDelta = entry
    }
    pendingMessageDeltaEvents++
    const pendingContent = pendingMessageDelta.attributes?.["message.content"]
    if (pendingMessageDeltaEvents >= messageDeltaChunkEvents
      || String(pendingContent ?? "").length >= messageDeltaChunkCharacters) {
      flushMessageDelta()
    }
  }
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const journal = {
    [agentInvocationJournalTraceLogSymbol]: true,
    async append(event: TraceEvent) {
      const safeEntryPromise = Promise.resolve(createTraceEventLog({ content }).append(event))
      void safeEntryPromise.catch(() => {})
      const metadataContentValues = captureMetadataContentValues(event, metadataContent)
      let entry: TraceEventLogEntry
      try {
        entry = await traceLog.append(event)
      }
      catch {
        entry = await safeEntryPromise
      }
      try {
        const safeEntry = await safeEntryPromise
        safeEntry.timestamp = entry.timestamp
        if (content === "metadata") restoreMetadataContentValues(safeEntry, metadataContentValues)
        if (safeEntry.name === "agent.message.delta") {
          queueMessageDelta(safeEntry)
        }
        else {
          flushMessageDelta()
          emit(safeEntry)
        }
      }
      catch {}
      return entry
    },
    entries() {
      flushMessageDelta()
      return traceLog.entries()
    },
  } as TraceEventLog
  if (content === "content") {
    Object.defineProperty(journal, agentInvocationJournalContentTraceLogSymbol, { value: true })
  }
  return journal
}

export function defineAgentInvocations(options: AgentInvocationsOptions): AgentInvocations {
  assertStore(options?.store)
  if (options.configuration !== undefined && options.configuration !== "content" && options.configuration !== "metadata") {
    throw agentDiagnostics.AGENT_R0624({ message: '[vitehub] Agent Invocations configuration must be "content" or "metadata".' })
  }
  if (options.content !== undefined && options.content !== "content" && options.content !== "metadata") {
    throw agentDiagnostics.AGENT_R0624({ message: '[vitehub] Agent Invocations content must be "content" or "metadata".' })
  }
  if (options.metadataContent?.some(key => CANONICAL_TRACE_ATTRIBUTE_KEYS.has(key))) {
    throw agentDiagnostics.AGENT_R0625({ message: "[vitehub] Agent Invocations metadataContent cannot include reserved trace attributes." })
  }
  if (options.metadataContent?.some(key => !isTraceContentAttributeKey(key))) {
    throw agentDiagnostics.AGENT_R0626({ message: "[vitehub] Agent Invocations metadataContent entries must name content attributes." })
  }
  const configuredObservationLimits = observationLimits(options.observations)
  const content = options.content || "metadata"
  const metadataContent = new Set(options.metadataContent || [])
  if (options.configuration === "content") metadataContent.add("vitehub.agent.configuration")
  const store = options.store
  const invocations: BoundAgentInvocations = {
    [agentInvocationsBrand]: true,
    async [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
      context: AgentRuntimeContext<TRuntimeConfig>,
      bindOptions: { agentName?: string, deferClaim?: boolean, terminalTakeover?: boolean } = {},
    ): Promise<AgentInvocationJournal<TRuntimeConfig>> {
      const runId = context.run?.runId || createInvocationId()
      const agentName = bindOptions.agentName || context.agentIdentity?.name
      const recordId = await agentInvocationId(runId, agentName)
      const claimId = createInvocationId()
      const traceId = await boundedIdentity(context.trace?.id || runId)
      const annotations = normalizeAnnotations(context.run?.annotations)
      let writes = Promise.resolve()
      let finished = false
      let boundToTerminalRecord = false
      let finishing = false
      let ownsRecord = false
      let limits = configuredObservationLimits
      let observationCount = 0
      let observationsTruncated = false
      let truncationPersisted = false
      let observationSequence = 0
      let created = false
      let creationTimedOut = false
      let creationTask: Promise<AgentInvocationStoreCreateResult | undefined> | undefined
      let runningPersisted = false
      let runningRequested = false
      let createInput: AgentInvocationStoreCreateInput
      let runningRetry: Promise<void> | undefined
      let terminalRetry: Promise<void> | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let observationWrite: Promise<void> | undefined
      let activeObservation: TraceEventLogEntry | undefined
      const pendingObservations: TraceEventLogEntry[] = []
      const terminalRetryObservations: TraceEventLogEntry[] = []
      const terminalObservationRecoveries: Array<() => Promise<void>> = []
      const ambiguouslyPersistingObservations = new Set<string | number>()
      const observedCapabilityIds = new Set<string>()
      const persistedObservations = new Set<string | number>()
      const retriedObservations = new WeakSet<TraceEventLogEntry>()
      const stopHeartbeat = () => {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        heartbeat = undefined
      }
      const startHeartbeat = () => {
        if (finished || !ownsRecord || heartbeat !== undefined) return
        heartbeat = setInterval(() => { void renew() }, CLAIM_RENEW_INTERVAL_MS)
        unrefTimer(heartbeat)
      }
      const ensureCreated = async (): Promise<boolean> => {
        if (created || creationTimedOut) return created
        if (!creationTask) {
          const task = Promise.resolve().then(() => store.create(createInput)).then((result) => {
            if (result) {
              limits = observationLimits(result.record.observationLimits)
              observationCount = result.record.observations.length
              observationsTruncated = result.record.observationsTruncated === true
                || result.record.observations.some(observation => observation.attributes?.["vitehub.trace.truncated"] === true)
              truncationPersisted = result.record.observationsTruncated === true
              observationSequence = Math.max(observationSequence, ...result.record.observations.map(observation => observation.sequence))
              invocationCapabilityIds(result.record).forEach(capabilityId => observedCapabilityIds.add(capabilityId))
              finished = terminalStatus(result.record.status)
              boundToTerminalRecord = finished
              created = true
            }
            else if (creationTask === task) {
              creationTask = undefined
              creationTimedOut = false
            }
            return result
          }, () => {
            if (creationTask === task) {
              creationTask = undefined
              creationTimedOut = false
            }
            return undefined
          })
          creationTask = task
        }
        const result = await boundedStoreOperation(() => creationTask!)
        if (result === storeOperationTimedOut) creationTimedOut = true
        return created
      }
      const renew = async (force = false): Promise<boolean> => {
        if (!await ensureCreated()) return false
        const claim = await boundedStoreOperation(() => store.claim(recordId, claimId, CLAIM_LEASE_MS, force ? { replaceExisting: true } : undefined))
        ownsRecord = claim === true
        if (ownsRecord && finished) {
          await boundedStoreOperation(() => store.release(recordId, claimId))
          ownsRecord = false
          stopHeartbeat()
          return false
        }
        if (ownsRecord) startHeartbeat()
        else stopHeartbeat()
        return ownsRecord
      }
      const write = async (operation: () => MaybePromise<unknown>): Promise<void> => {
        writes = writes.then(async () => {
          try { await operation() }
          catch {}
        })
        await writes
      }
      const now = new Date().toISOString()
      createInput = {
          ...(agentName ? { agentName: boundedString(agentName) } : {}),
          ...(annotations ? { annotations } : {}),
          ...(context.run?.channelId ? { channelId: boundedString(context.run.channelId) } : {}),
          createdAt: now,
          id: recordId,
          observations: [],
          ...(options.observations ? { observationLimits: { ...limits } } : {}),
          ...(context.run?.origin ? { origin: boundedString(context.run.origin) } : {}),
          status: "pending",
          ...(context.run?.threadId ? { threadId: boundedString(context.run.threadId) } : {}),
          traceId,
          updatedAt: now,
      }
      await ensureCreated()
      if (!bindOptions.deferClaim) await renew()
      const baseTraceLog = context.traceLog || createTraceEventLog()
      const update = async (input: AgentInvocationStoreUpdateInput, force = false): Promise<boolean> => {
        let updated = false
        await write(async () => {
          if (!await renew(force)) return
          const operation = Promise.resolve().then(() => store.update(recordId, input, claimId))
          const result = await boundedStoreOperation(() => operation)
          updated = result !== undefined && result !== storeOperationTimedOut
          if (result === storeOperationTimedOut && input.observation && recoverableOutcomeObservation(input.observation)) {
            const observation = input.observation
            const key = observationPersistenceKey(observation)
            ambiguouslyPersistingObservations.add(key)
            terminalObservationRecoveries.push(async () => {
              const record = await boundedStoreOperation(() => store.get(recordId))
              if (record && record !== storeOperationTimedOut
                && record.observations.some(candidate => sameObservation(candidate, observation))) {
                persistedObservations.add(key)
                return
              }
              await persistLateObservation(observation)
            })
          }
        })
        return updated
      }
      const markTruncated = async (force = false) => {
        if (truncationPersisted) return
        truncationPersisted = await update({ observationsTruncated: true, timestamp: new Date().toISOString() }, force)
      }
      const writeNextObservation = () => {
        if (finished || observationWrite) return
        const observation = pendingObservations.shift()
        if (!observation) return
        activeObservation = observation
        const task = (async () => {
          let failed = false
          let persisted = false
          try {
            if (finished || !await renew()) return
            const timestamp = normalizedTimestamp(observation.timestamp)
            const persistedObservation = await boundedJournalObservation({
              ...observation,
              timestamp,
              ...(observation.trace ? { trace: { ...observation.trace, id: traceId } } : {}),
            }, limits)
            const previousObservationCount = observationCount
            const persistence = Promise.resolve().then(() => store.update(recordId, {
              observation: persistedObservation,
              timestamp,
            }, claimId)).then((updated) => {
              if (updated && (observationIdentity(observation) === undefined
                ? updated.observations.length > previousObservationCount
                : updated.observations.some(candidate => sameObservation(candidate, observation)))) {
                persistedObservations.add(observationPersistenceKey(observation))
              }
              return updated
            })
            const updated = await boundedStoreOperation(() => persistence)
            if (updated && updated !== storeOperationTimedOut) {
              observationCount = updated.observations.length
              persisted = true
            }
            else if (updated === undefined
              || (updated === storeOperationTimedOut && recoverableOutcomeObservation(observation))) failed = true
          }
          finally {
            if (failed && !finished) {
              observationsTruncated = true
              void markTruncated()
            }
            if (!persisted
              && !finished
              && !finishing
              && outcomeObservationPriority(observation) !== undefined) {
              if (!retriedObservations.has(observation)) {
                observationsTruncated = true
                const retry = truncatedObservation(observation)
                retriedObservations.add(retry)
                prioritizePendingOutcomes(pendingObservations, retry, undefined, limits.maxCount)
              }
              else if (failed) {
                terminalRetryObservations.push(observation)
              }
            }
          }
        })().catch(() => {})
        const settled = task.finally(() => {
          if (observationWrite === settled) {
            observationWrite = undefined
            activeObservation = undefined
            writeNextObservation()
          }
        })
        observationWrite = settled
      }
      const persistLateObservation = async (observation: TraceEventLogEntry): Promise<void> => {
        const deadline = Date.now() + TERMINAL_RETRY_TIMEOUT_MS
        let persisted = false
        while (!persisted && Date.now() < deadline) {
          await write(async () => {
            if (!await ensureCreated()) return
            const claimed = await boundedStoreOperation(() => store.claim(recordId, claimId, CLAIM_LEASE_MS, { replaceExisting: true }))
            if (claimed !== true) return
            try {
              const timestamp = normalizedTimestamp(observation.timestamp)
              const persistedObservation = { ...observation, timestamp }
              if (observation.trace) persistedObservation.trace = { ...observation.trace, id: traceId }
              const update = Promise.resolve().then(() => store.update(recordId, {
                observation: boundedObservation(persistedObservation, undefined, limits),
                timestamp,
              }, claimId))
              const boundedUpdate = await boundedStoreOperation(() => update)
              const updated = boundedUpdate === storeOperationTimedOut
                ? await boundedStoreOperation(() => update, Math.max(0, deadline - Date.now()))
                : boundedUpdate
              persisted = updated !== undefined && updated !== storeOperationTimedOut
            }
            finally {
              await boundedStoreOperation(() => store.release(recordId, claimId))
            }
          })
          if (!persisted && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, TERMINAL_RETRY_INTERVAL_MS)
              unrefTimer(timer)
            })
          }
        }
      }
      const observe = (observation: TraceEventLogEntry) => {
        const capabilityId = observationCapabilityId(observation)
        if (capabilityId && observedCapabilityIds.size < MAX_CAPABILITY_IDS) observedCapabilityIds.add(capabilityId)
        if (finished) {
          if (!boundToTerminalRecord && recoverableOutcomeObservation(observation)) {
            registerAgentInvocationRecovery(context, persistLateObservation(observation))
          }
          return
        }
        if (finishing) {
          if (recoverableOutcomeObservation(observation)) terminalRetryObservations.push(observation)
          return
        }
        const atCapacity = observationCount + pendingObservations.length + (observationWrite ? 1 : 0) >= limits.maxCount
        const priority = outcomeObservationPriority(observation)
        const queuedObservation = priority !== undefined && (atCapacity || observationsTruncated)
          ? truncatedObservation(observation)
          : observation
        if (atCapacity) {
          const persistTruncation = !observationsTruncated
          observationsTruncated = true
          if (persistTruncation) void markTruncated()
          if (priority === undefined) {
            if (capabilityId) {
              void update({ capabilityIds: [capabilityId], timestamp: normalizedTimestamp(observation.timestamp) })
            }
            return
          }
          prioritizePendingOutcomes(pendingObservations, queuedObservation, activeObservation, limits.maxCount)
          writeNextObservation()
          return
        }
        pendingObservations.push(queuedObservation)
        writeNextObservation()
      }
      return {
        configuration: options.configuration,
        context: {
          ...context,
          run: { ...context.run, runId },
          trace: context.trace || { id: runId },
          traceLog: journalTraceLog(baseTraceLog, observe, () => ++observationSequence, content, metadataContent),
        },
        async finish(status, error) {
          if (finished || finishing) return
          finishing = true
          const finishingObservations = [activeObservation, ...pendingObservations]
          const observationDeadline = Date.now() + limits.flushTimeoutMs
          while (observationWrite && Date.now() < observationDeadline) {
            await boundedStoreOperation(() => observationWrite!, observationDeadline - Date.now())
          }
          const outcomeObservations = [...finishingObservations, activeObservation, ...pendingObservations]
            .filter((observation): observation is TraceEventLogEntry => observation !== undefined)
            .filter((observation, index, observations) => observations.findIndex(candidate => sameObservation(candidate, observation)) === index)
          const unpersistedOutcomes = outcomeObservations
            .filter(observation => !persistedObservations.has(observationPersistenceKey(observation)))
          const pendingOutcomes = await Promise.all(retainedPriorityOutcomes(unpersistedOutcomes, limits.maxCount)
            .map(observation => boundedJournalObservation({
              ...observation,
              timestamp: normalizedTimestamp(observation.timestamp),
              ...(observation.trace ? { trace: { ...observation.trace, id: traceId } } : {}),
            }, limits)))
          const pendingOutcomeKeys = new Set(pendingOutcomes.map(observationPersistenceKey))
          const discardedObservationKeys = unpersistedOutcomes
            .filter(observation => !pendingOutcomeKeys.has(observationPersistenceKey(observation)))
            .map(observationPersistenceKey)
          pendingObservations.length = 0
          if (runningRequested && !runningPersisted) {
            runningPersisted = await update({ status: "running", timestamp: new Date().toISOString() })
          }
          const failure = errorDetails(error)
          for (const observation of pendingOutcomes.slice(0, -1)) {
            const persisted = await update({ observation, timestamp: observation.timestamp })
            if (!persisted && recoverableOutcomeObservation(observation)
              && !ambiguouslyPersistingObservations.has(observationPersistenceKey(observation))) {
              terminalRetryObservations.push(observation)
            }
          }
          const terminalOutcome = pendingOutcomes.at(-1)
          const finishInput: AgentInvocationStoreUpdateInput = {
            ...(observedCapabilityIds.size ? { capabilityIds: [...observedCapabilityIds] } : {}),
            ...(failure ? { error: failure } : {}),
            ...(terminalOutcome ? { observation: terminalOutcome } : {}),
            status,
            timestamp: new Date().toISOString(),
          }
          const finishOnce = async () => {
            if (finished) return false
            let updated = await update(finishInput, bindOptions.terminalTakeover)
            let terminalOutcomePersisted = updated || terminalOutcome === undefined
            if (!updated && terminalOutcome !== undefined) {
              updated = await update({
                ...(observedCapabilityIds.size ? { capabilityIds: [...observedCapabilityIds] } : {}),
                ...(failure ? { error: failure } : {}),
                status,
                timestamp: finishInput.timestamp,
              }, bindOptions.terminalTakeover)
              terminalOutcomePersisted = false
            }
            if (!updated) return false
            if (!terminalOutcomePersisted && terminalOutcome && recoverableOutcomeObservation(terminalOutcome)
              && !ambiguouslyPersistingObservations.has(observationPersistenceKey(terminalOutcome))) {
              terminalRetryObservations.push(terminalOutcome)
            }
            if (discardedObservationKeys.some(key => !persistedObservations.has(key))) {
              await markTruncated(bindOptions.terminalTakeover)
            }
            finished = true
            stopHeartbeat()
            if (ownsRecord) await write(() => boundedStoreOperation(() => store.release(recordId, claimId)))
            ownsRecord = false
            const recoveries = terminalObservationRecoveries.splice(0)
            const observations = terminalRetryObservations.splice(0)
            if (recoveries.length > 0 || observations.length > 0) {
              registerAgentInvocationRecovery(context, Promise.all([
                ...recoveries.map(recover => recover()),
                ...observations.map(persistLateObservation),
              ]).then(() => undefined))
            }
            return true
          }
          if (await finishOnce() || terminalRetry) return
          const retryWork = (async () => {
            const deadline = Date.now() + TERMINAL_RETRY_TIMEOUT_MS
            while (!finished && Date.now() < deadline) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, TERMINAL_RETRY_INTERVAL_MS)
                unrefTimer(timer)
              })
              await finishOnce()
            }
            if (!finished) {
              stopHeartbeat()
              if (ownsRecord) await write(() => boundedStoreOperation(() => store.release(recordId, claimId)))
              ownsRecord = false
            }
          })()
          const retry = retryWork.finally(async () => {
            if (!finished && terminalRetry === retry) {
              terminalRetry = undefined
              finishing = false
              const recoveries = terminalObservationRecoveries.splice(0)
              const observations = terminalRetryObservations.splice(0)
              await Promise.all([
                ...recoveries.map(recover => recover()),
                ...observations.map(persistLateObservation),
              ])
            }
          })
          terminalRetry = retry
          registerAgentInvocationRecovery(context, retry)
        },
        async running() {
          if (finished) return
          runningRequested = true
          const markRunning = async () => {
            runningPersisted = await update({ status: "running", timestamp: new Date().toISOString() })
            return runningPersisted
          }
          if (await markRunning() || runningRetry) return
          runningRetry = (async () => {
            const deadline = Date.now() + TERMINAL_RETRY_TIMEOUT_MS
            while (!finished && Date.now() < deadline) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, TERMINAL_RETRY_INTERVAL_MS)
                unrefTimer(timer)
              })
              if (finished) return
              if (await markRunning()) return
            }
          })()
          registerAgentInvocationRecovery(context, runningRetry)
        },
        async setAnnotations(annotations) {
          if (finished || finishing) return
          await update({ annotations: normalizeAnnotations(annotations), timestamp: new Date().toISOString() })
        },
      }
    },
    async appendObservation(id, event, appendOptions) {
      assertInvocationId(id)
      assertInvocationId(appendOptions.id)
      if (appendOptions.id.length > MAX_METADATA_STRING_LENGTH) {
        throw agentDiagnostics.AGENT_R0901({ message: "[vitehub] Appended observation IDs must be at most 512 characters." })
      }
      const existing = await store.get(id)
      if (!existing) return undefined
      const limits = observationLimits(existing.observationLimits)
      const metadataContentValues = captureMetadataContentValues(event, metadataContent)
      const observation = await createTraceEventLog({ content }).append(event)
      if (content === "metadata") restoreMetadataContentValues(observation, metadataContentValues)
      const prepared = await boundedJournalObservation({
        ...observation,
        attributes: { ...observation.attributes, [AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE]: appendOptions.id },
      }, limits)
      const { sequence: _sequence, ...appendObservation } = prepared
      const updated = await store.update(id, { appendObservation, timestamp: prepared.timestamp })
      const persisted = updated || await store.get(id)
      if (persisted && !persisted.observations.some(entry => observationIdentity(entry) === appendOptions.id)) {
        throw agentDiagnostics.AGENT_R0902({ message: "[vitehub] Invocation store did not persist appended observation." })
      }
      return persisted
    },
    async get(id) {
      assertInvocationId(id)
      return await store.get(id)
    },
    async getByRunId(runId, agentName) {
      return await store.get(await agentInvocationId(runId, agentName))
    },
    async getSummary(id) {
      assertInvocationId(id)
      return await store.getSummary(id)
    },
    async list(options = {}) {
      const search = normalizeSearch(options.search)
      const normalized = { ...options, limit: normalizeLimit(options.limit) }
      const capabilityId = options.capabilityId?.trim()
      if (capabilityId) normalized.capabilityId = capabilityId
      else delete normalized.capabilityId
      if (search) normalized.search = search
      else delete normalized.search
      return await store.list(normalized)
    },
    async listAgentNames() {
      if (store.listAgentNames) {
        return [...new Set((await store.listAgentNames()).map(name => name.trim()).filter(Boolean))]
          .sort()
      }
      const names = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await store.list({ cursor, limit: MAX_LIST_LIMIT })
        for (const invocation of page.invocations) {
          if (invocation.agentName?.trim()) names.add(invocation.agentName.trim())
        }
        cursor = page.cursor
      } while (cursor)
      return [...names].sort()
    },
    async listCapabilityIds(agentName) {
      const selectedAgent = agentName?.trim()
      if (store.listCapabilityIds) {
        return [...new Set((await store.listCapabilityIds(selectedAgent))
          .map(capabilityId => capabilityId.trim())
          .filter(Boolean))]
          .sort()
      }
      const capabilityIds = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await store.list({ ...(selectedAgent ? { agentName: selectedAgent } : {}), cursor, limit: MAX_LIST_LIMIT })
        const records = await Promise.all(page.invocations.map(invocation => store.get(invocation.id)))
        for (const record of records) {
          if (record) invocationCapabilityIds(record).forEach(capabilityId => capabilityIds.add(capabilityId))
        }
        cursor = page.cursor
      } while (cursor)
      return [...capabilityIds].sort()
    },
  }
  return invocations
}

export async function bindAgentInvocations<TRuntimeConfig extends AgentRuntimeConfig>(
  invocations: AgentInvocations | undefined,
  context: AgentRuntimeContext<TRuntimeConfig>,
  options?: { agentName?: string, deferClaim?: boolean, terminalTakeover?: boolean },
): Promise<AgentInvocationJournal<TRuntimeConfig> | undefined> {
  if (!invocations) return
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const bind = (invocations as Partial<BoundAgentInvocations>)[bindAgentInvocationsSymbol]
  if (!hasRuntimeType(bind, "function")) {
    throw agentDiagnostics.AGENT_R0627({ message: "[vitehub] defineAgent({ invocations }) requires a definition created by defineAgentInvocations()." })
  }
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  return await bind.call(invocations, context, options) as AgentInvocationJournal<TRuntimeConfig>
}
