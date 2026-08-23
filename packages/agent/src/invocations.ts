import { asUnknownBoundary, hasRuntimeType } from "./internal/runtime-type.ts"
import { createTraceEventLog, isTraceContentAttributeKey, normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { registerAgentInvocationRecovery } from "./internal/invocation-recovery.ts"
import { agentInvocationJournalContentTraceLogSymbol, agentInvocationJournalTraceLogSymbol } from "./trace.ts"

import type { AgentInvocationStatus } from "./agent-invocation.ts"
import type { AgentRunMetadata, AgentRuntimeConfig, AgentRuntimeContext, MaybePromise } from "./types.ts"
import type { RuntimeDiagnosticError, TraceEvent, TraceEventContentPolicy, TraceEventLog, TraceEventLogEntry } from "@vite-hub/runtime"

const bindAgentInvocationsSymbol = Symbol("vitehub.bindAgentInvocations")
const agentInvocationsBrand: unique symbol = Symbol("vitehub.agentInvocations")

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100
const MAX_ANNOTATIONS = 32
const MAX_ANNOTATION_KEY_LENGTH = 64
const MAX_ANNOTATION_STRING_LENGTH = 512
const MAX_METADATA_STRING_LENGTH = 512
const MAX_OBSERVATION_CONTENT_STRING_LENGTH = 64 * 1024
const MAX_OBSERVATIONS = 256
const MAX_OBSERVATION_ATTRIBUTES = 32
const MAX_OBSERVATION_COLLECTION_ITEMS = 32
const MAX_OBSERVATION_DEPTH = 4
const MAX_OBSERVATION_VALUE_ITEMS = 256
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
  error?: RuntimeDiagnosticError
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
  content?: TraceEventContentPolicy
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
    ...(record.error ? { error: structuredClone(record.error) } : {}),
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

interface ObservationBudget {
  items: number
  stringLength: number
}

function boundedObservationValue(value: unknown, budget: ObservationBudget, depth = 0, maxStringLength = MAX_METADATA_STRING_LENGTH): unknown {
  if (budget.items <= 0) return "[truncated]"
  budget.items--
  if (value === undefined) return undefined
  if (hasRuntimeType(value, "string")) {
    if (budget.stringLength <= 0) return "[truncated]"
    const length = Math.min(value.length, maxStringLength, budget.stringLength)
    budget.stringLength -= length
    return value.slice(0, length)
  }
  if (value === null || hasRuntimeType(value, "boolean")) return value
  if (hasRuntimeType(value, "number")) return Number.isFinite(value) ? value : null
  if (hasRuntimeType(value, "bigint")) return boundedString(String(value))
  if (depth >= MAX_OBSERVATION_DEPTH) return "[truncated]"
  if (Array.isArray(value)) {
    return value.slice(0, Math.min(MAX_OBSERVATION_COLLECTION_ITEMS, budget.items)).map(item => item === undefined ? null : boundedObservationValue(item, budget, depth + 1, maxStringLength))
  }
  if (!value || !hasRuntimeType(value, "object")) return boundedString(String(value))
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .slice(0, Math.min(MAX_OBSERVATION_COLLECTION_ITEMS, budget.items))
    .flatMap(([key, child]) => child === undefined ? [] : [[boundedString(key), boundedObservationValue(child, budget, depth + 1, maxStringLength)]]))
}

function boundedObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  const budget: ObservationBudget = {
    items: MAX_OBSERVATION_VALUE_ITEMS,
    stringLength: MAX_OBSERVATION_CONTENT_STRING_LENGTH,
  }
  const attributes = observation.attributes
    ? Object.fromEntries(Object.entries(observation.attributes)
        .slice(0, MAX_OBSERVATION_ATTRIBUTES)
        .flatMap(([key, value]) => value === undefined ? [] : [[boundedString(key), boundedObservationValue(value, budget, 0, isTraceContentAttributeKey(key) ? MAX_OBSERVATION_CONTENT_STRING_LENGTH : MAX_METADATA_STRING_LENGTH)]]))
    : undefined
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
  if (!hasRuntimeType(id, "string") || !id.trim()) {
    throw new TypeError("[vitehub] Agent Invocations require a non-empty invocation id.")
  }
}

function assertStore(store: AgentInvocationStore | undefined): asserts store is AgentInvocationStore {
  if (!store
    || !hasRuntimeType(store.claim, "function")
    || !hasRuntimeType(store.create, "function")
    || !hasRuntimeType(store.get, "function")
    || !hasRuntimeType(store.list, "function")
    || !hasRuntimeType(store.release, "function")
    || !hasRuntimeType(store.update, "function")) {
    throw new TypeError("[vitehub] Agent Invocations require a store with claim(), create(), get(), list(), release(), and update().")
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
  return observation.name === "agent.invocation.finish" || observation.name === "agent.invocation.error" || observation.name === "run.finish" || observation.name === "run.error"
}

function failureEvidenceObservation(observation: TraceEventLogEntry): boolean {
  return observation.name === "run.error"
    || (observation.name === "agent.stream.error" && observation.attributes?.["error.recoverable"] !== true)
}

function outcomeObservationPriority(observation: TraceEventLogEntry): number | undefined {
  if (failureEvidenceObservation(observation)) return 0
  if (terminalObservation(observation)) return 1
}

function truncatedObservation(observation: TraceEventLogEntry): TraceEventLogEntry {
  return {
    ...observation,
    attributes: { ...observation.attributes, "vitehub.trace.truncated": true },
  }
}

function prioritizePendingOutcomes(
  pending: TraceEventLogEntry[],
  incoming: TraceEventLogEntry,
  active: TraceEventLogEntry | undefined,
  retryIncoming = false,
): void {
  const activeFatal = active && failureEvidenceObservation(active)
  const fatal = retryIncoming && failureEvidenceObservation(incoming)
    ? incoming
    : activeFatal
      ? undefined
      : pending.find(failureEvidenceObservation)
        ?? (failureEvidenceObservation(incoming) ? incoming : undefined)
  const pendingTerminal = pending.findLast(terminalObservation)
  const terminal = retryIncoming
    ? pendingTerminal ?? (terminalObservation(incoming) ? incoming : undefined)
    : terminalObservation(incoming)
      ? incoming
      : pendingTerminal
  const outcomes: TraceEventLogEntry[] = []
  if (fatal) outcomes.push(fatal)
  if (terminal && terminal !== fatal) outcomes.push(terminal)
  const ordinary = pending.filter(observation => !failureEvidenceObservation(observation) && !terminalObservation(observation))
  const ordinaryLimit = Math.max(0, MAX_OBSERVATIONS - (active ? 1 : 0) - outcomes.length)
  pending.splice(0, pending.length, ...outcomes, ...ordinary.slice(0, ordinaryLimit))
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
  const observations = input.observation
    ? record.observations.length < MAX_OBSERVATIONS
      ? (() => {
          const observation = cloneObservation(boundedObservation(input.observation))
          const priority = outcomeObservationPriority(observation)
          const insertAt = record.observations.findIndex((candidate) => {
            const candidatePriority = outcomeObservationPriority(candidate)
            return candidatePriority !== undefined && (priority === undefined || candidatePriority > priority)
          })
          return insertAt < 0
            ? [...record.observations, observation]
            : [...record.observations.slice(0, insertAt), observation, ...record.observations.slice(insertAt)]
        })()
      : (() => {
          const failureEvidence = record.observations.find(failureEvidenceObservation)
            ?? (failureEvidenceObservation(input.observation) ? input.observation : undefined)
          const terminal = terminalObservation(input.observation)
            ? input.observation
            : record.observations.findLast(terminalObservation)
          const retained = record.observations.filter(observation => observation !== failureEvidence && observation !== terminal)
          if (failureEvidence && terminal && failureEvidence !== terminal) {
            return [
              ...retained.slice(0, MAX_OBSERVATIONS - 2),
              cloneObservation(boundedObservation(truncatedObservation(failureEvidence))),
              cloneObservation(boundedObservation(truncatedObservation(terminal))),
            ]
          }
          const outcome = failureEvidence || terminal
          return [
            ...retained.slice(0, MAX_OBSERVATIONS - 1),
            cloneObservation(boundedObservation(truncatedObservation(outcome || record.observations.at(-1)!))),
          ]
        })()
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
  content: TraceEventContentPolicy,
): TraceEventLog {
  const messageDeltaChunkCharacters = MAX_METADATA_STRING_LENGTH
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
      const entry = await traceLog.append(event)
      try {
        const safeEntry = await createTraceEventLog({ content }).append({ ...event, timestamp: entry.timestamp })
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
  if (options.content !== undefined && options.content !== "content" && options.content !== "metadata") {
    throw new TypeError('[vitehub] Agent Invocations content must be "content" or "metadata".')
  }
  const content = options.content || "metadata"
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
      let finishing = false
      let ownsRecord = false
      let observationCount = 0
      let observationsTruncated = false
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
      let activeObservation: TraceEventLogEntry | undefined
      const pendingObservations: TraceEventLogEntry[] = []
      const persistedObservationSequences = new Set<number>()
      const retriedObservations = new WeakSet<TraceEventLogEntry>()
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
              observationsTruncated = result.record.observations.some(observation => observation.attributes?.["vitehub.trace.truncated"] === true)
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
      const writeNextObservation = () => {
        if (finished || observationWrite) return
        const observation = pendingObservations.shift()
        if (!observation) return
        activeObservation = observation
        const task = (async () => {
          let persisted = false
          try {
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
            if (updated && updated !== storeOperationTimedOut) {
              observationCount = updated.observations.length
              persisted = true
              persistedObservationSequences.add(observation.sequence)
            }
          }
          finally {
            if (!persisted
              && !finished
              && !finishing
              && outcomeObservationPriority(observation) !== undefined
              && !retriedObservations.has(observation)) {
              observationsTruncated = true
              const retry = truncatedObservation(observation)
              retriedObservations.add(retry)
              prioritizePendingOutcomes(pendingObservations, retry, undefined, true)
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
      const observe = (observation: TraceEventLogEntry) => {
        if (finished || finishing) return
        const atCapacity = observationCount + pendingObservations.length + (observationWrite ? 1 : 0) >= MAX_OBSERVATIONS
        const priority = outcomeObservationPriority(observation)
        const queuedObservation = priority !== undefined && (atCapacity || observationsTruncated)
          ? truncatedObservation(observation)
          : observation
        if (atCapacity) {
          observationsTruncated = true
          if (priority === undefined) return
          prioritizePendingOutcomes(pendingObservations, queuedObservation, activeObservation)
          writeNextObservation()
          return
        }
        pendingObservations.push(queuedObservation)
        writeNextObservation()
      }
      return {
        context: {
          ...context,
          run: { ...context.run, runId },
          trace: context.trace || { id: runId },
          traceLog: journalTraceLog(baseTraceLog, observe, () => ++observationSequence, content),
        },
        async finish(status, error) {
          if (finished || finishing) return
          finishing = true
          const finishingActiveObservation = activeObservation
          const observationDeadline = Date.now() + STORE_OPERATION_TIMEOUT_MS
          while (observationWrite && Date.now() < observationDeadline) {
            await boundedStoreOperation(() => observationWrite!, observationDeadline - Date.now())
          }
          const outcomeObservations = [finishingActiveObservation, activeObservation, ...pendingObservations]
            .filter((observation): observation is TraceEventLogEntry => observation !== undefined)
            .filter((observation, index, observations) => observations.findIndex(candidate => candidate.sequence === observation.sequence) === index)
          const unpersistedOutcomes = outcomeObservations.filter(observation => !persistedObservationSequences.has(observation.sequence))
          const pendingFailure = unpersistedOutcomes.find(failureEvidenceObservation)
          const pendingTerminal = unpersistedOutcomes.findLast(terminalObservation)
          const pendingOutcomes = [pendingFailure, pendingTerminal]
            .filter((observation): observation is TraceEventLogEntry => observation !== undefined)
            .filter((observation, index, outcomes) => outcomes.indexOf(observation) === index)
            .map(observation => boundedObservation({
              ...observation,
              timestamp: normalizedTimestamp(observation.timestamp),
              ...(observation.trace ? { trace: { ...observation.trace, id: traceId } } : {}),
            }))
          pendingObservations.length = 0
          if (runningRequested && !runningPersisted) {
            runningPersisted = await update({ status: "running", timestamp: new Date().toISOString() })
          }
          const failure = errorDetails(error)
          for (const observation of pendingOutcomes.slice(0, -1)) {
            await update({ observation, timestamp: observation.timestamp })
          }
          const terminalOutcome = pendingOutcomes.at(-1)
          const finishInput: AgentInvocationStoreUpdateInput = {
            ...(failure ? { error: failure } : {}),
            ...(terminalOutcome ? { observation: terminalOutcome } : {}),
            status,
            timestamp: new Date().toISOString(),
          }
          const finishOnce = async () => {
            if (finished) return false
            const updated = await update(finishInput, bindOptions.terminalTakeover)
              || terminalOutcome !== undefined && await update({
                ...(failure ? { error: failure } : {}),
                status,
                timestamp: finishInput.timestamp,
              }, bindOptions.terminalTakeover)
            if (!updated) return false
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
            if (!finished && terminalRetry === retry) {
              terminalRetry = undefined
              finishing = false
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
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const bind = (invocations as Partial<BoundAgentInvocations>)[bindAgentInvocationsSymbol]
  if (!hasRuntimeType(bind, "function")) {
    throw new TypeError("[vitehub] defineAgent({ invocations }) requires a definition created by defineAgentInvocations().")
  }
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  return await bind.call(invocations, context, options) as AgentInvocationJournal<TRuntimeConfig>
}
