import { createTraceEventLog } from "@vite-hub/runtime"
import { registerAgentInvocationRecovery } from "./internal/invocation-recovery.ts"

import type { AgentInvocationStatus } from "./agent-invocation.ts"
import type { AgentRunMetadata, AgentRuntimeConfig, AgentRuntimeContext, MaybePromise } from "./types.ts"
import type { TraceEvent, TraceEventLog, TraceEventLogEntry } from "@vite-hub/runtime"

// Agent Definitions can cross Vite SSR module realms. Use the global registry so
// a journal created by the host remains bindable in the module runner.
const bindAgentInvocationsSymbol = Symbol.for("vitehub.bindAgentInvocations")
const agentInvocationsBrand: unique symbol = Symbol("vitehub.agentInvocations")

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_ANNOTATIONS = 32
const MAX_ANNOTATION_KEY_LENGTH = 64
const MAX_ANNOTATION_STRING_LENGTH = 512
const MAX_METADATA_STRING_LENGTH = 512
const MAX_OBSERVATIONS = 256
const MAX_OBSERVATION_ATTRIBUTES = 32
const MAX_OBSERVATION_COLLECTION_ITEMS = 32
const MAX_OBSERVATION_DEPTH = 4
const OBSERVATION_TRUNCATED_ATTRIBUTE = "vitehub.observation.truncated"
const CLAIM_LEASE_MS = 30_000
const CLAIM_HEARTBEAT_TIMEOUT_MS = 60 * 60_000
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
  cancelledAt?: string
  channelId?: string
  completedAt?: string
  createdAt: string
  cursor: string
  error?: {
    message: string
    name?: string
  }
  failedAt?: string
  id: string
  observations: readonly TraceEventLogEntry[]
  origin?: string
  startedAt?: string
  status: AgentInvocationRecordStatus
  threadId?: string
  traceId: string
  updatedAt: string
}

export interface AgentInvocationListOptions {
  cursor?: string
  limit?: number
  search?: string
  status?: AgentInvocationRecordStatus | readonly AgentInvocationRecordStatus[]
}

export type AgentInvocationSummary = Omit<AgentInvocationRecord, "observations">

export interface AgentInvocationListResult {
  cursor?: string
  invocations: readonly AgentInvocationSummary[]
}

export type AgentInvocationStoreCreateInput = Omit<AgentInvocationRecord, "cursor">

export interface AgentInvocationStoreCreateResult {
  created: boolean
  record: AgentInvocationRecord
}

export interface AgentInvocationStoreUpdateInput {
  error?: AgentInvocationRecord["error"]
  observation?: TraceEventLogEntry
  status?: AgentInvocationRecordStatus
  timestamp: string
}

export interface AgentInvocationStore {
  claim(id: string, claimId: string, leaseMs: number, force?: boolean): MaybePromise<boolean>
  create(input: AgentInvocationStoreCreateInput): MaybePromise<AgentInvocationStoreCreateResult>
  get(id: string): MaybePromise<AgentInvocationRecord | undefined>
  list(options?: AgentInvocationListOptions): MaybePromise<AgentInvocationListResult>
  release(id: string, claimId: string): MaybePromise<void>
  update(id: string, input: AgentInvocationStoreUpdateInput, claimId?: string): MaybePromise<AgentInvocationRecord | undefined>
}

export interface AgentInvocationsOptions {
  store: AgentInvocationStore
}

export interface AgentInvocations {
  readonly [agentInvocationsBrand]: true
  get(id: string): Promise<AgentInvocationRecord | undefined>
  getByRunId(runId: string, agentName?: string): Promise<AgentInvocationRecord | undefined>
  list(options?: AgentInvocationListOptions): Promise<AgentInvocationListResult>
}

interface BoundAgentInvocations extends AgentInvocations {
  [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
    context: AgentRuntimeContext<TRuntimeConfig>,
    options?: { agentName?: string, deferClaim?: boolean, terminalTakeover?: boolean },
  ): Promise<AgentInvocationJournal<TRuntimeConfig>>
}

export interface AgentInvocationJournal<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  context: AgentRuntimeContext<TRuntimeConfig>
  finish(status: Extract<AgentInvocationRecordStatus, "completed" | "failed" | "cancelled">, error?: unknown): Promise<void>
  running(): Promise<void>
}

function cloneObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  return {
    ...observation,
    ...(observation.attributes ? { attributes: structuredClone(observation.attributes) } : {}),
    ...(observation.trace ? { trace: { ...observation.trace } } : {}),
  }
}

function cloneRecord(record: AgentInvocationRecord): AgentInvocationRecord {
  return {
    ...record,
    ...(record.annotations ? { annotations: { ...record.annotations } } : {}),
    ...(record.error ? { error: { ...record.error } } : {}),
    observations: record.observations.map(cloneObservation),
  }
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

function normalizeAnnotations(input: AgentRunMetadata["annotations"]): Record<string, AgentInvocationAnnotationValue> | undefined {
  if (!input || typeof input !== "object") return
  const annotations: Record<string, AgentInvocationAnnotationValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(annotations).length >= MAX_ANNOTATIONS) break
    if (!annotationKey(key)) continue
    if (typeof value === "string") annotations[key] = value.slice(0, MAX_ANNOTATION_STRING_LENGTH)
    else if (typeof value === "number" && Number.isFinite(value)) annotations[key] = value
    else if (typeof value === "boolean" || value === null) annotations[key] = value
  }
  return Object.keys(annotations).length ? annotations : undefined
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("[vitehub] Agent Invocation list limit must be a positive integer.")
  }
  return Math.min(limit, MAX_LIST_LIMIT)
}

function normalizeSearch(search: string | undefined): string | undefined {
  if (search === undefined) return
  if (typeof search !== "string") {
    throw new TypeError("[vitehub] Agent Invocation search must be a string.")
  }
  const value = search.trim()
  if (!value) return
  if (value.length > 256) {
    throw new TypeError("[vitehub] Agent Invocation search must be at most 256 characters.")
  }
  return value
}

function matchesInvocationSearch(record: AgentInvocationRecord, search: string | undefined): boolean {
  if (!search) return true
  const { observations: _observations, ...summary } = record
  return JSON.stringify(summary).toLowerCase().includes(search.toLowerCase())
}

function normalizeBuiltInCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== cursor) {
    throw new TypeError("[vitehub] Agent Invocation cursor is invalid.")
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

function boundedObservationValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundedString(value)
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "bigint") return boundedString(String(value))
  if (depth >= MAX_OBSERVATION_DEPTH) return "[truncated]"
  if (Array.isArray(value)) {
    return value.slice(0, MAX_OBSERVATION_COLLECTION_ITEMS).map(item => boundedObservationValue(item, depth + 1))
  }
  if (!value || typeof value !== "object") return boundedString(String(value))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_OBSERVATION_COLLECTION_ITEMS)
    .map(([key, child]) => [boundedString(key), boundedObservationValue(child, depth + 1)]))
}

export function agentInvocationObservationWouldTruncate(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.length > MAX_METADATA_STRING_LENGTH
  if (value === null || typeof value === "boolean" || typeof value === "number") return false
  if (typeof value === "bigint") return String(value).length > MAX_METADATA_STRING_LENGTH
  if (depth >= MAX_OBSERVATION_DEPTH) return true
  if (Array.isArray(value)) {
    return value.length > MAX_OBSERVATION_COLLECTION_ITEMS
      || value.some(item => agentInvocationObservationWouldTruncate(item, depth + 1))
  }
  if (!value || typeof value !== "object") return String(value).length > MAX_METADATA_STRING_LENGTH
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length > MAX_OBSERVATION_COLLECTION_ITEMS
    || entries.some(([key, child]) => key.length > MAX_METADATA_STRING_LENGTH || agentInvocationObservationWouldTruncate(child, depth + 1))
}

function boundedObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  const attributeEntries = Object.entries(observation.attributes ?? {})
  const attributesTruncated = attributeEntries.length > MAX_OBSERVATION_ATTRIBUTES
    || attributeEntries.some(([key, value]) => key.length > MAX_METADATA_STRING_LENGTH || agentInvocationObservationWouldTruncate(value))
  const attributes = observation.attributes
    ? Object.fromEntries(attributeEntries
        .slice(0, attributesTruncated ? MAX_OBSERVATION_ATTRIBUTES - 1 : MAX_OBSERVATION_ATTRIBUTES)
        .map(([key, value]) => [boundedString(key), boundedObservationValue(value)]))
    : undefined
  if (attributesTruncated) attributes![OBSERVATION_TRUNCATED_ATTRIBUTE] = true
  return {
    ...observation,
    name: boundedString(observation.name)!,
    timestamp: normalizedTimestamp(observation.timestamp),
    ...(attributes ? { attributes } : {}),
    ...(observation.trace
      ? { trace: {
          ...observation.trace,
          id: boundedString(observation.trace.id)!,
          ...(observation.trace.parentId ? { parentId: boundedString(observation.trace.parentId) } : {}),
        } }
      : {}),
  }
}

async function boundedIdentity(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `sha256_${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}

function invocationIdentity(runId: string, agentName?: string): string {
  return JSON.stringify([agentName ?? null, runId])
}

function assertInvocationId(id: string): void {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("[vitehub] Agent Invocations require a non-empty invocation id.")
  }
}

function assertStore(store: AgentInvocationStore | undefined): asserts store is AgentInvocationStore {
  if (!store
    || typeof store.claim !== "function"
    || typeof store.create !== "function"
    || typeof store.get !== "function"
    || typeof store.list !== "function"
    || typeof store.release !== "function"
    || typeof store.update !== "function") {
    throw new TypeError("[vitehub] Agent Invocations require a store with claim(), create(), get(), list(), release(), and update().")
  }
}

function errorDetails(error: unknown): AgentInvocationRecord["error"] | undefined {
  if (error === undefined) return
  if (error instanceof Error) return {
    message: boundedString(error.message || error.name)!,
    ...(error.name ? { name: boundedString(error.name) } : {}),
  }
  return { message: boundedString(typeof error === "string" ? error : "Agent Invocation failed.")! }
}

function terminalStatus(status: AgentInvocationRecordStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // SAFETY: Node timers expose optional unref; browser timers are numbers and therefore have no method.
  const unref = (timer as { unref?: () => void }).unref
  if (unref) unref.call(timer)
}

export function applyAgentInvocationStoreUpdate(
  record: AgentInvocationRecord,
  input: AgentInvocationStoreUpdateInput,
): AgentInvocationRecord {
  if (terminalStatus(record.status)) return record
  const status = input.status && (!terminalStatus(record.status) || input.status === record.status)
    ? input.status
    : record.status
  const observations = input.observation && record.observations.length >= MAX_OBSERVATIONS
    ? record.observations.map((observation, index) => index === record.observations.length - 1
        ? {
            ...observation,
            attributes: {
              ...observation.attributes,
              [OBSERVATION_TRUNCATED_ATTRIBUTE]: true,
            },
          }
        : observation)
    : input.observation
      ? [...record.observations, cloneObservation(boundedObservation(input.observation))]
      : record.observations
  return {
    ...record,
    ...(input.error ? { error: input.error } : {}),
    observations,
    ...(status === "running" && !record.startedAt ? { startedAt: input.timestamp } : {}),
    ...(status === "completed" && !record.completedAt ? { completedAt: input.timestamp } : {}),
    ...(status === "failed" && !record.failedAt ? { failedAt: input.timestamp } : {}),
    ...(status === "cancelled" && !record.cancelledAt ? { cancelledAt: input.timestamp } : {}),
    status,
    updatedAt: input.timestamp,
  }
}

export function createMemoryAgentInvocationStore(): AgentInvocationStore {
  const claims = new Map<string, { claimId: string, expiresAt: number }>()
  const records = new Map<string, AgentInvocationRecord>()
  let cursor = 0
  return {
    claim(id, claimId, leaseMs, force) {
      const claim = claims.get(id)
      if (!records.has(id) || (!force && claim && claim.claimId !== claimId && claim.expiresAt > Date.now())) return false
      claims.set(id, { claimId, expiresAt: Date.now() + leaseMs })
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
    list(options = {}) {
      const limit = normalizeLimit(options.limit)
      const cursor = normalizeBuiltInCursor(options.cursor)
      const search = normalizeSearch(options.search)
      const statuses = options.status === undefined
        ? undefined
        : new Set(Array.isArray(options.status) ? options.status : [options.status])
      const before = cursor === undefined ? Number.POSITIVE_INFINITY : Number(cursor)
      const candidates = [...records.values()]
        .filter(record => Number(record.cursor) < before && (!statuses || statuses.has(record.status)) && matchesInvocationSearch(record, search))
        .sort((a, b) => Number(b.cursor) - Number(a.cursor))
      const page = candidates.slice(0, limit)
      return {
        ...(candidates.length > limit && page.length ? { cursor: page.at(-1)!.cursor } : {}),
        invocations: page.map(record => {
          const { observations: _observations, ...summary } = cloneRecord(record)
          return summary
        }),
      }
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

function journalTraceLog(
  traceLog: TraceEventLog,
  observe: (entry: TraceEventLogEntry) => void,
  nextSequence: () => number,
): TraceEventLog {
  const messageDeltaChunkCharacters = 4_096
  const messageDeltaChunkEvents = 32
  let pendingMessageDelta: TraceEventLogEntry | undefined
  let pendingMessageDeltaEvents = 0
  const emit = (entry: TraceEventLogEntry) => {
    void observe({ ...entry, sequence: nextSequence() })
  }
  const flushMessageDelta = () => {
    if (!pendingMessageDelta) return
    emit(pendingMessageDelta)
    pendingMessageDelta = undefined
    pendingMessageDeltaEvents = 0
  }
  return {
    async append(event: TraceEvent) {
      let entry: TraceEventLogEntry
      try {
        entry = await traceLog.append(event)
      }
      catch {
        entry = await createTraceEventLog().append(event)
      }
      try {
        if (entry.name === "agent.message.delta") {
          const pending = pendingMessageDelta
          const previousContent = pending?.attributes?.["message.content"]
          const content = entry.attributes?.["message.content"]
          const sameMessage = pending
            && pending.attributes?.["message.id"] === entry.attributes?.["message.id"]
            && pending.attributes?.["message.phase"] === entry.attributes?.["message.phase"]
            && pending.attributes?.["message.role"] === entry.attributes?.["message.role"]
          if (sameMessage && (previousContent === undefined) === (content === undefined)) {
            const attributes = {
              ...pending.attributes,
              ...entry.attributes,
            }
            if (previousContent !== undefined && content !== undefined) {
              attributes["message.content"] = `${previousContent}${content}`
            }
            pendingMessageDelta = {
              ...entry,
              attributes,
            }
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
        else {
          flushMessageDelta()
          emit(entry)
        }
      }
      catch {}
      return entry
    },
    entries() {
      flushMessageDelta()
      return traceLog.entries()
    },
  }
}

export function defineAgentInvocations(options: AgentInvocationsOptions): AgentInvocations {
  assertStore(options?.store)
  const store = options.store
  const invocations: BoundAgentInvocations = {
    [agentInvocationsBrand]: true,
    async [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
      context: AgentRuntimeContext<TRuntimeConfig>,
      bindOptions: { agentName?: string, deferClaim?: boolean, terminalTakeover?: boolean } = {},
    ): Promise<AgentInvocationJournal<TRuntimeConfig>> {
      const runId = context.run?.runId || createInvocationId()
      const agentName = bindOptions.agentName || context.agentIdentity?.name
      const recordId = await boundedIdentity(invocationIdentity(runId, agentName))
      const claimId = createInvocationId()
      const traceId = await boundedIdentity(context.trace?.id || runId)
      const annotations = normalizeAnnotations(context.run?.annotations)
      let writes = Promise.resolve()
      let finished = false
      let ownsRecord = false
      let observationCount = 0
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
      let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined
      let heartbeatDeadline: number | undefined
      let observationWrite: Promise<void> | undefined
      const pendingObservations: TraceEventLogEntry[] = []
      const stopHeartbeat = () => {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        if (heartbeatTimeout !== undefined) clearTimeout(heartbeatTimeout)
        heartbeat = undefined
        heartbeatTimeout = undefined
      }
      const startHeartbeat = () => {
        if (finished || !ownsRecord || heartbeat !== undefined) return
        heartbeatDeadline ??= Date.now() + CLAIM_HEARTBEAT_TIMEOUT_MS
        if (Date.now() >= heartbeatDeadline) return
        heartbeat = setInterval(() => { void renew() }, CLAIM_RENEW_INTERVAL_MS)
        unrefTimer(heartbeat)
        heartbeatTimeout = setTimeout(stopHeartbeat, heartbeatDeadline - Date.now())
        unrefTimer(heartbeatTimeout)
      }
      const ensureCreated = async (): Promise<boolean> => {
        if (created || creationTimedOut) return created
        if (!creationTask) {
          const task = Promise.resolve().then(() => store.create(createInput)).then((result) => {
            if (result) {
              observationCount = result.record.observations.length
              observationSequence = Math.max(observationSequence, ...result.record.observations.map(observation => observation.sequence))
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
        const claim = await boundedStoreOperation(() => store.claim(recordId, claimId, CLAIM_LEASE_MS, force))
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
          const result = await boundedStoreOperation(() => store.update(recordId, input, claimId))
          updated = result !== undefined && result !== storeOperationTimedOut
        })
        return updated
      }
      const writeNextObservation = (flushFinal = false) => {
        if (finished || observationWrite) return
        if (
          observationCount >= MAX_OBSERVATIONS - 1
          && pendingObservations.length === 1
          && !flushFinal
        ) return
        let observation = pendingObservations.shift()
        if (!observation) return
        if (observationCount >= MAX_OBSERVATIONS - 1 && pendingObservations.length > 0) {
          observation = {
            ...observation,
            attributes: {
              ...observation.attributes,
              [OBSERVATION_TRUNCATED_ATTRIBUTE]: true,
            },
          }
          pendingObservations.length = 0
          observationCapMarked = true
        }
        const task = (async () => {
          if (finished || !await renew()) return
          const timestamp = normalizedTimestamp(observation.timestamp)
          const persistedObservation = boundedObservation({
            ...observation,
            timestamp,
            ...(observation.trace ? { trace: { ...observation.trace, id: traceId } } : {}),
          })
          const updated = await boundedStoreOperation(() => store.update(recordId, {
            observation: persistedObservation,
            timestamp,
          }, claimId))
          if (updated && updated !== storeOperationTimedOut) observationCount = updated.observations.length
        })().catch(() => {})
        const settled = task.finally(() => {
          if (observationWrite === settled) {
            observationWrite = undefined
            writeNextObservation()
          }
        })
        observationWrite = settled
      }
      let observationCapMarked = false
      const observe = (observation: TraceEventLogEntry) => {
        if (finished) return
        if (observationCapMarked) return
        if (observationCount + pendingObservations.length + (observationWrite ? 1 : 0) >= MAX_OBSERVATIONS) {
          const retained = pendingObservations.at(-1)
          if (retained) {
            pendingObservations[pendingObservations.length - 1] = {
              ...retained,
              attributes: {
                ...retained.attributes,
                [OBSERVATION_TRUNCATED_ATTRIBUTE]: true,
              },
            }
            observationCapMarked = true
          }
          return
        }
        pendingObservations.push(observation)
        writeNextObservation()
      }
      return {
        context: {
          ...context,
          run: { ...context.run, runId },
          trace: context.trace || { id: runId },
          traceLog: journalTraceLog(baseTraceLog, observe, () => ++observationSequence),
        },
        async finish(status, error) {
          if (finished) return
          const observationDeadline = Date.now() + STORE_OPERATION_TIMEOUT_MS
          while ((observationWrite || pendingObservations.length > 0) && Date.now() < observationDeadline) {
            writeNextObservation(true)
            if (observationWrite) {
              await boundedStoreOperation(() => observationWrite!, observationDeadline - Date.now())
            }
          }
          pendingObservations.length = 0
          if (runningRequested && !runningPersisted) {
            runningPersisted = await update({ status: "running", timestamp: new Date().toISOString() })
          }
          const finishInput: AgentInvocationStoreUpdateInput = {
              ...(errorDetails(error) ? { error: errorDetails(error) } : {}),
              status,
              timestamp: new Date().toISOString(),
          }
          const finishOnce = async () => {
            if (finished || !await update(finishInput, bindOptions.terminalTakeover)) return false
            finished = true
            stopHeartbeat()
            if (ownsRecord) await write(() => boundedStoreOperation(() => store.release(recordId, claimId)))
            ownsRecord = false
            return true
          }
          if (await finishOnce() || terminalRetry) return
          const retry = (async () => {
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
          })().finally(() => {
            if (!finished && terminalRetry === retry) terminalRetry = undefined
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
      }
    },
    async get(id) {
      assertInvocationId(id)
      return await store.get(id)
    },
    async getByRunId(runId, agentName) {
      assertInvocationId(runId)
      return await store.get(await boundedIdentity(invocationIdentity(runId, agentName)))
    },
    async list(options = {}) {
      const search = normalizeSearch(options.search)
      const normalized = { ...options, limit: normalizeLimit(options.limit) }
      if (search) normalized.search = search
      else delete normalized.search
      return await store.list(normalized)
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
  const bind = (invocations as Partial<BoundAgentInvocations>)[bindAgentInvocationsSymbol]
  if (typeof bind !== "function") {
    throw new TypeError("[vitehub] defineAgent({ invocations }) requires a definition created by defineAgentInvocations().")
  }
  return await bind.call(invocations, context, options) as AgentInvocationJournal<TRuntimeConfig>
}
