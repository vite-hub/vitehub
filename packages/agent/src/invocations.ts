import { maxAgentInvocationListLimit as MAX_LIST_LIMIT, normalizeAgentInvocationListOptions } from "./invocations/list-options.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { isRuntimeRecord } from "./internal/runtime-type.ts"
import { searchableAgentInvocationText } from "./invocations/search.ts"
import { createTraceEventLog, isTraceContentAttributeKey, normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { registerAgentInvocationRecovery } from "./internal/invocation-recovery.ts"
import { abortLocalAgentInvocation, createAgentInvocationCancellationError, registerAgentInvocationCancellation } from "./internal/invocation-cancellation.ts"
import { AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE, createInvocationObservationStream } from "./internal/invocation-observation-stream.ts"
import { agentInvocationJournalContentTraceLogSymbol, agentInvocationJournalTraceLogSymbol } from "./trace.ts"
import { failInterruptedAgentInvocations } from "./server/invocation-health.ts"

import type { AgentInvocationCancellationDriver } from "./internal/invocation-cancellation.ts"
import type { AgentInvocationStatus } from "./agent-invocation.ts"
import type { AgentRunMetadata, AgentRuntimeConfig, AgentRuntimeContext, MaybePromise } from "./types.ts"
import type { RuntimeDiagnosticError, TraceEvent, TraceEventContentPolicy, TraceEventLog, TraceEventLogEntry, TraceEventPayload } from "@vite-hub/runtime"
import { agentDiagnostics } from "./agent-diagnostics.ts"

const bindAgentInvocationsSymbol = Symbol("vitehub.bindAgentInvocations")
const recoverInterruptedAgentInvocationsSymbol = Symbol("vitehub.recoverInterruptedAgentInvocations")
const agentInvocationsBrand: unique symbol = Symbol("vitehub.agentInvocations")

const MAX_ANNOTATIONS = 32
const MAX_ANNOTATION_KEY_LENGTH = 64
const MAX_ANNOTATION_STRING_LENGTH = 512
const MAX_CAPABILITY_IDS = 256
const MAX_METADATA_STRING_LENGTH = 512
const MAX_OBSERVATION_CONTENT_STRING_LENGTH = 64 * 1024
const MAX_OBSERVATIONS = 32 * 1024
const DEFAULT_OBSERVATION_BYTES = 16 * 1024 * 1024
const MAX_OBSERVATION_ATTRIBUTES = 32
const MAX_OBSERVATION_COLLECTION_ITEMS = 32
const MAX_USAGE_RECORD_DEPTH = 16
const MAX_USAGE_RECORD_ITEMS = 65_536
const MAX_USAGE_RECORD_CALLS = 4_096
const MAX_OBSERVATION_DEPTH = 4
const MAX_AGENT_CONFIGURATION_DEPTH = 64
const MAX_OBSERVATION_VALUE_ITEMS = 256
const MAX_AGENT_CONFIGURATION_ITEMS = 32 * 1024
const MAX_AGENT_CONFIGURATION_COLLECTION_ITEMS = 8 * 1024
export { AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE } from "./internal/invocation-observation-stream.ts"
const AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE = "vitehub.input.redacted"
const AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE = "vitehub.observation.id"
const PROMPT_TRUNCATED_ATTRIBUTE = "input.prompt.truncated"
const INVOKER_PROFILE_TRUNCATED_ATTRIBUTE = "agent.invoker.profile.id.truncated"
const APPENDED_OBSERVATION_ATTRIBUTE = "vitehub.observation.appended"
const CANONICAL_TRACE_ATTRIBUTE_KEYS = new Set([
  "input.replay.version",
  "input.promptChanged",
  "input.hasInvoker",
  "input.hasResolvedInvoker",
  "input.hasContext",
  "input.hasRunMetadata",
  "input.hasTimeout",
  "input.hasAbortSignal",
  "input.hasDryRun",
  "input.hasData",
  "input.hasOptions",
  "input.hasMessages",
  AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE,
  AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE,
  APPENDED_OBSERVATION_ATTRIBUTE,
  PROMPT_TRUNCATED_ATTRIBUTE,
  INVOKER_PROFILE_TRUNCATED_ATTRIBUTE,
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
const CANCELLATION_VERIFICATION_TIMEOUT_MS = 5_000
const CANCELLATION_VERIFICATION_INTERVAL_MS = 100
const STORE_OPERATION_TIMEOUT_MS = 1_000
const storeOperationTimedOut = Symbol("vitehub.storeOperationTimedOut")

export type AgentInvocationAnnotationValue = boolean | number | string | null
export type AgentInvocationRecordStatus = AgentInvocationStatus

export interface AgentInvocationWorkflowBinding {
  name: string
  provider: string
  /** Absent while provider acknowledgement is unknown. */
  id?: string
}

export interface AgentInvocationRecord {
  /** Durable provider dispatch intent and acknowledged physical identity. */
  workflow?: AgentInvocationWorkflowBinding
  agentName?: string
  annotations?: Record<string, AgentInvocationAnnotationValue>
  /** Capability IDs observed during this Invocation, including uses omitted from a truncated trace. */
  capabilityIds?: readonly string[]
  cancelledAt?: string
  /** Driver that received this Invocation but cannot enforce a cancellation request. */
  cancelNotEnforcedBy?: string
  /** True while the custom Driver dispatch state has not been durably verified. */
  cancelWarningPending?: boolean
  /** Execution owner whose Driver cancellation state is represented by this record. */
  cancelWarningOwnerId?: string
  /** Time of the first cancellation request. The run that holds the Invocation reads it within the claim renewal interval. */
  cancelRequestedAt?: string
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
  triggeredBy?: string
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
  workflow?: AgentInvocationWorkflowBinding
  /** Append with a stable observation identity and a sequence assigned atomically by the store. */
  appendObservation?: Omit<TraceEventLogEntry, "sequence">
  annotations?: AgentInvocationRecord["annotations"]
  /** Current Driver that cannot enforce cancellation. `null` clears a previous Driver's marker. */
  cancelNotEnforcedBy?: string | null
  /** Whether custom Driver dispatch is unverified. `false` clears the pending state. */
  cancelWarningPending?: boolean
  /** Execution owner whose Driver cancellation state is represented by this update. */
  cancelWarningOwnerId?: string
  /** Requests cancellation. Stores ignore it on terminal records. */
  cancelRequestedAt?: string
  capabilityIds?: readonly string[]
  channelId?: string
  origin?: string
  threadId?: string
  error?: AgentInvocationRecord["error"]
  observation?: TraceEventLogEntry
  observationsTruncated?: boolean
  status?: AgentInvocationRecordStatus
  timestamp: string
}

export interface AgentInvocationStore {
  claim(id: string, claimId: string, leaseMs: number, options?: {
    /** Atomically rotate only an absent claim or one of these owned generations, unless replaceExisting is true. */
    expectedClaimIds?: readonly string[]
    replaceClaimToken?: string
    replaceExisting?: boolean
  }): MaybePromise<boolean>
  create(input: AgentInvocationStoreCreateInput): MaybePromise<AgentInvocationStoreCreateResult>
  get(id: string, options?: { observationNames?: readonly string[] }): MaybePromise<AgentInvocationRecord | undefined>
  /** Reads invocation metadata without observation payloads. */
  getSummary(id: string): MaybePromise<AgentInvocationSummary | undefined>
  getClaimToken(id: string): MaybePromise<string | undefined>
  list(options?: AgentInvocationListOptions): MaybePromise<AgentInvocationListResult>
  listAgentNames?(): MaybePromise<readonly string[]>
  listCapabilityIds?(agentName?: string): MaybePromise<readonly string[]>
  listTriggeredBy?(agentName?: string): MaybePromise<readonly string[]>
  release(id: string, claimId: string): MaybePromise<void>
  /** Deletes one terminal record and the claim the store keeps for it. Pending and running records remain. */
  delete?(id: string): MaybePromise<AgentInvocationDeleteOutcome>
  /** Deletes terminal records selected by `updatedBefore`, or by the store's configured retention when it is omitted. */
  prune?(options: AgentInvocationStorePruneOptions): MaybePromise<AgentInvocationPruneResult>
  /** Updates are idempotent for observations carrying the ViteHub observation identity attribute. */
  update(id: string, input: AgentInvocationStoreUpdateInput, claimId?: string): MaybePromise<AgentInvocationRecord | undefined>
}

/** Retention limits for terminal records. Pending and running records are never removed by retention. */
export interface AgentInvocationRetentionOptions {
  /** Maximum age of terminal records, measured from their last update. Set to false to disable age-based retention. */
  maxAgeMs?: false | number
  /** Maximum number of terminal records. Set to false to disable count-based retention. */
  maxRecords?: false | number
}

/** `not-terminal` means the record is pending or running and was kept. */
export type AgentInvocationDeleteOutcome = "deleted" | "not-found" | "not-terminal"

export interface AgentInvocationStorePruneOptions {
  /** Report the selected record IDs without deleting them. */
  dryRun?: boolean
  /** ISO timestamp. Selects terminal records last updated before this time. */
  updatedBefore?: string
}

export interface AgentInvocationPruneOptions {
  /** Report the selected record IDs without deleting them. */
  dryRun?: boolean
  /** Selects terminal records last updated more than this many milliseconds ago. Omit it to apply the store's configured retention. */
  olderThanMs?: number
}

export interface AgentInvocationPruneResult {
  /** True when the store reported the selection without deleting it. */
  dryRun: boolean
  /** Deleted record IDs, or the IDs a dry run selected. */
  ids: readonly string[]
}

export interface AgentInvocationObservationOptions {
  /** Retained observations, including lifecycle outcomes. Default 32768; maximum 32768. */
  maxCount?: number
  /** Maximum content string length in UTF-16 code units. Default 65536; maximum 1048576. */
  maxStringLength?: number
  /** Maximum UTF-8 bytes of the serialized observations array. Default 16 MiB; maximum 64 MiB. Updates fail if configuration truncation evidence cannot fit. */
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
  const maximum = { maxCount: 32 * 1024, maxStringLength: 1024 * 1024, maxBytes: 64 * 1024 * 1024, flushTimeoutMs: 60_000 }
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
  /** Rewrite an observation after the content policy and before the store receives it. Return undefined to drop it. A throwing hook drops the observation. */
  redact?: (observation: AgentInvocationRecord["observations"][number]) => AgentInvocationRecord["observations"][number] | undefined
  /** Rewrite the error stored on a failed invocation. Return undefined to store no error details. A throwing hook stores no error details. */
  redactError?: (error: NonNullable<AgentInvocationRecord["error"]>) => AgentInvocationRecord["error"]
  store: AgentInvocationStore
}

export interface AgentInvocationCancelResult {
  /**
   * Where the request was sent or recorded; this does not confirm execution stopped.
   * `local`: a run in this process received an aborted signal.
   * `journal`: the store retained the request for a current or future execution owner.
   */
  delivery?: "journal" | "local"
  id: string
  /** Driver that cannot enforce an abort request. This does not confirm that its execution owner received the request. */
  notEnforcedBy?: string
  /**
   * `requested`: the request was recorded or sent locally; owner observation is unconfirmed.
   * `terminal`: the journal has a final state; a stale local Driver may still be active.
   * `not-found`: the journal has no Invocation with this id.
   * `unavailable`: the store did not keep the request and no run in this process holds the Invocation.
   */
  outcome: "not-found" | "requested" | "terminal" | "unavailable"
  status?: AgentInvocationRecordStatus
}

export interface AgentInvocations {
  /** Durably append evidence to a live or terminal invocation. Repeated IDs return the existing observation. */
  appendObservation(id: string, event: TraceEvent, options: { id: string }): Promise<AgentInvocationRecord | undefined>
  readonly [agentInvocationsBrand]: true
  /** Whether the configured store implements deletion. */
  readonly supportsDelete: boolean
  /** Deletes one terminal record. Rejects when the store does not implement deletion. */
  delete(id: string): Promise<AgentInvocationDeleteOutcome>
  /**
   * Requests cancellation of a pending or running Invocation. A run in this process aborts at once.
   * A run in another process reads the journal flag at its next claim renewal.
   */
  cancel(id: string): Promise<AgentInvocationCancelResult>
  get(id: string, options?: { observationNames?: readonly string[] }): Promise<AgentInvocationRecord | undefined>
  getByRunId(runId: string, agentName?: string): Promise<AgentInvocationRecord | undefined>
  /** Reads invocation metadata without observation payloads. */
  getSummary(id: string): Promise<AgentInvocationSummary | undefined>
  list(options?: AgentInvocationListOptions): Promise<AgentInvocationListResult>
  listAgentNames(): Promise<readonly string[]>
  listCapabilityIds(agentName?: string): Promise<readonly string[]>
  listTriggeredBy(agentName?: string): Promise<readonly string[]>
  /** Deletes terminal records. Rejects when the store does not implement pruning. */
  prune(options?: AgentInvocationPruneOptions): Promise<AgentInvocationPruneResult>
}

export function isAgentInvocations(value: unknown): value is AgentInvocations {
  return isRuntimeRecord(value) && Reflect.get(value, agentInvocationsBrand) === true
}

interface BoundAgentInvocations extends AgentInvocations {
  [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
    context: AgentRuntimeContext<TRuntimeConfig>,
    options?: { agentName?: string, cancellationDriver?: AgentInvocationCancellationDriver, deferClaim?: boolean, terminalTakeover?: boolean, requireNew?: boolean, replaceClaimToken?: string, recoverPending?: boolean },
  ): Promise<AgentInvocationJournal<TRuntimeConfig>>
  [recoverInterruptedAgentInvocationsSymbol](options: Parameters<typeof failInterruptedAgentInvocations>[1]): Promise<number>
}

export const exclusiveAgentInvocation: unique symbol = Symbol("vitehub.exclusiveAgentInvocation")
export const inheritedAgentInvocationClaim: unique symbol = Symbol("vitehub.inheritedAgentInvocationClaim")
export const pendingAgentInvocationAnnotation = "vitehub.invocation.executionPending"
export const workflowDispatchAttemptedAnnotation = "vitehub.invocation.workflowDispatchAttempted"

export function pendingAgentInvocationAnnotations(input: AgentRunMetadata["annotations"]): NonNullable<AgentRunMetadata["annotations"]> {
  const annotations: NonNullable<AgentRunMetadata["annotations"]> = { [pendingAgentInvocationAnnotation]: true, [workflowDispatchAttemptedAnnotation]: false }
  for (const [key, value] of Object.entries(input || {})) {
    if (key !== pendingAgentInvocationAnnotation && key !== workflowDispatchAttemptedAnnotation) annotations[key] = value
  }
  return annotations
}

export class AgentInvocationClaimConflict extends Error {
  constructor() {
    super("Invocation already exists or is claimed.")
    this.name = "AgentInvocationClaimConflict"
  }
}

export interface AgentInvocationJournal<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  /** Aborts when a user requests cancellation of this Invocation. */
  abortSignal: AbortSignal
  configuration?: TraceEventContentPolicy
  /** Whether this journal holds the store execution claim, lost it, or could not reach the store. */
  readonly createdNew: boolean
  readonly claimStatus?: "owned" | "conflict" | "unavailable"
  context: AgentRuntimeContext<TRuntimeConfig>
  /** The stored `traceId`, available after creation confirms the record identity. */
  traceId: string | undefined
  /** Wait for an asynchronous create attempt to resolve its stored identity. */
  ready(): Promise<void>
  finish(status: Extract<AgentInvocationRecordStatus, "completed" | "failed" | "cancelled">, error?: unknown): Promise<void>
  getWorkflowDispatchAttempted(): Promise<boolean | undefined>
  handoffClaim(options?: { workflowDispatch?: boolean }): Promise<string | undefined>
  prepareWorkflowDispatch(binding: AgentInvocationWorkflowBinding): Promise<boolean>
  confirmWorkflowDispatch(binding?: AgentInvocationWorkflowBinding): Promise<boolean>
  releaseClaim(): Promise<void>
  /** Persist the execution-start marker; false means execution must not begin. */
  running(): Promise<boolean>
  setAnnotations(annotations: AgentRunMetadata["annotations"]): Promise<void>
  /** Persist resolved run metadata while this journal owns the execution claim. */
  setRunMetadata(run: AgentRunMetadata): Promise<boolean>
  /** Records the Driver dispatch boundary without delaying execution. */
  driverStarted(): void
  /** Registers this run and checks durable cancellation before setup or dispatch consumes {@link abortSignal}. */
  watchCancellation(driver: AgentInvocationCancellationDriver): Promise<void>
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
    ...(record.workflow ? { workflow: { ...record.workflow } } : {}),
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

function matchesInvocationSearch(record: AgentInvocationRecord, search: string | undefined): boolean {
  if (!search) return true
  return searchableAgentInvocationText(record).includes(search.toLowerCase())
}

function boundedString(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, MAX_METADATA_STRING_LENGTH)
}

function normalizedTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value)
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString()
}

interface ObservationBudget {
  deferredText?: Array<() => void>
  collectionItems?: number
  items: number
  maxDepth?: number
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
  const collectionItems = budget.collectionItems ?? MAX_OBSERVATION_COLLECTION_ITEMS
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
    const length = Math.min(value.length, collectionItems, budget.items)
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
    const limit = Math.min(collectionItems, budget.items)
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
    const limit = Math.min(collectionItems, budget.items)
    for (const entry of value) {
      if (entries.length >= limit) break
      entries.push(entry)
    }
    if (entries.length < value.size) budget.truncated = true
    return entries.map(child => boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns))
  }
  if (value instanceof ArrayBuffer) {
    budget.truncated = true
    const length = Math.min(value.byteLength, collectionItems, budget.items)
    return boundedObservationValue(Array.from(new Uint8Array(value, 0, length)), budget, depth + 1, maxStringLength, builtIns)
  }
  if (ArrayBuffer.isView(value)) {
    budget.truncated = true
    const length = Math.min(value.byteLength, collectionItems, budget.items)
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
    const length = Math.min(details.length, collectionItems)
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
  // Match JSON object semantics: optional undefined properties are absent data, not truncated data.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
  const length = Math.min(entries.length, collectionItems, budget.items)
  if (length < entries.length) budget.truncated = true
  const result: Record<string, unknown> = Object.fromEntries(entries
    .slice(0, length)
    .flatMap(([key, child]) => {
      if (key.length > MAX_METADATA_STRING_LENGTH) budget.truncated = true
      // Reserve message structure across the array before allocating text bodies.
      if (budget.deferredText && (key === "text" || key === "content") && hasRuntimeType(child, "string") && budget.items > 0) {
        budget.items--
        budget.deferredText.push(() => {
          const length = Math.min(child.length, maxStringLength, budget.stringLength)
          if (length < child.length) budget.truncated = true
          budget.stringLength -= length
          result[key] = length || !child.length ? child.slice(0, length) : "[truncated]"
        })
        return [[key, ""]]
      }
      return [[boundedString(key), boundedObservationValue(child, budget, depth + 1, maxStringLength, builtIns)]]
    }))
  return result
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
  if ((key === "input.messages" || key === "input.prompt") && Array.isArray(value)) {
    const messageBudget: ObservationBudget & { deferredText: Array<() => void> } = { ...budget, deferredText: [] }
    const messages = boundedObservationValue(value, messageBudget, 0, maxStringLength, builtIns)
    for (const writeText of messageBudget.deferredText) writeText()
    budget.items = messageBudget.items
    budget.stringLength = messageBudget.stringLength
    budget.truncated ||= messageBudget.truncated
    return messages
  }
  if (key === "message.content") {
    // Message chunks can fill the capture limit without consuming identity metadata space.
    const contentBudget = { ...budget, stringLength: maxStringLength }
    const content = boundedObservationValue(value, contentBudget, 0, maxStringLength, builtIns)
    budget.items = contentBudget.items
    budget.truncated ||= contentBudget.truncated
    return content
  }
  if (key === "usage.record") {
    // Per-response accounting nests model calls, usage partitions, and pricing evidence.
    // Keep it intact without raising limits for arbitrary tool payloads.
    const usageBudget: ObservationBudget = {
      items: MAX_USAGE_RECORD_ITEMS,
      collectionItems: MAX_USAGE_RECORD_CALLS,
      maxDepth: MAX_USAGE_RECORD_DEPTH,
      stringLength: MAX_OBSERVATION_CONTENT_STRING_LENGTH,
      truncated: false,
    }
    const usage = boundedObservationValue(value, usageBudget, 0, maxStringLength, builtIns)
    budget.truncated ||= usageBudget.truncated
    return usage
  }
  if (key !== "vitehub.agent.configuration") return boundedObservationValue(value, budget, 0, maxStringLength, builtIns)
  const configurationBudget: ObservationBudget = {
    items: 65_536,
    collectionItems: 65_536,
    maxDepth: MAX_AGENT_CONFIGURATION_DEPTH,
    stringLength: maxStringLength,
    truncated: false,
  }
  const configuration = boundedObservationValue(value, configurationBudget, 0, maxStringLength, builtIns)
  budget.truncated ||= configurationBudget.truncated
  return configuration
}

function boundedObservation(
  observation: TraceEventLogEntry,
  builtIns?: ReadonlyMap<object, BoundedObservationBuiltIn>,
  limits = defaultObservationLimits,
): TraceEventLogEntry {
  const agentConfiguration = observation.name === "vitehub.agent.configured"
  const budget: ObservationBudget = {
    ...(agentConfiguration ? { collectionItems: MAX_AGENT_CONFIGURATION_COLLECTION_ITEMS } : {}),
    items: agentConfiguration ? MAX_AGENT_CONFIGURATION_ITEMS : MAX_OBSERVATION_VALUE_ITEMS,
    ...(agentConfiguration ? { maxDepth: MAX_AGENT_CONFIGURATION_DEPTH } : {}),
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
  if (observation.name === "agent.invocation.start") {
    if (observation.attributes?.["input.replay.version"] === 5) canonicalAttributes["input.replay.version"] = 5
    for (const key of ["input.promptChanged", "input.hasInvoker", "input.hasResolvedInvoker", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasContext", "input.hasRunMetadata", "input.hasTimeout", "input.hasAbortSignal", "input.hasDryRun"]) {
      const value = observation.attributes?.[key]
      if (hasRuntimeType(value, "boolean")) canonicalAttributes[key] = value
    }
  }
  if (observation.attributes?.[AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE] === true) canonicalAttributes[AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE] = true
  if (observation.name === "agent.invocation.start" && observation.attributes?.["input.prompt"] !== undefined) {
    canonicalAttributes[PROMPT_TRUNCATED_ATTRIBUTE] = observation.attributes[PROMPT_TRUNCATED_ATTRIBUTE] === true
  }
  if (observation.name === "agent.invocation.start" && observation.attributes?.["agent.invoker.profile.id"] !== undefined) {
    canonicalAttributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] = observation.attributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] === true
  }
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
            key === "vitehub.agent.configuration" || isTraceContentAttributeKey(key) ? limits.maxStringLength : MAX_METADATA_STRING_LENGTH,
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
  if (observation.name === "agent.invocation.start" && observation.attributes?.["input.prompt"] !== undefined && attributes) {
    attributes[PROMPT_TRUNCATED_ATTRIBUTE] = attributes[PROMPT_TRUNCATED_ATTRIBUTE] === true
      || attributes["input.prompt"] !== observation.attributes["input.prompt"]
  }
  if (observation.name === "agent.invocation.start" && observation.attributes?.["agent.invoker.profile.id"] !== undefined && attributes) {
    attributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] = attributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] === true
      || attributes["agent.invoker.profile.id"] !== observation.attributes["agent.invoker.profile.id"]
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

/** Why a journaled Invocation cannot be started again with the same input. */
export type AgentInvocationRerunUnavailableReason =
  /** The Invocation has not reached a terminal state. */
  | "invocation-not-terminal"
  /** The journal has no start observation with a text prompt. */
  | "input-not-captured"
  /** The record predates the replay schema or lacks its required metadata. */
  | "replay-metadata-unavailable"
  /** The Invocation supplied an invoker identity, which the journal does not replay. */
  | "input-has-invoker"
  /** The Invocation received structured input, which the journal does not replay. */
  | "input-has-data"
  /** The Invocation received call options, which the journal does not replay. */
  | "input-has-options"
  /** The journal redactor changed the captured input or replay metadata. */
  | "input-redacted"
  /** The journal bounded the captured prompt or selected Invoker Profile. */
  | "input-truncated"
  /** The Invocation received messages or attachments, which the journal does not keep for replay. */
  | "input-has-messages"
  /** Trusted input context cannot be reconstructed from the captured prompt and profile. */
  | "input-has-context"
  /** Semantic run metadata is not retained by the rerun input. */
  | "input-has-run-metadata"
  /** The original Invocation set a timeout. */
  | "input-has-timeout"
  /** The caller supplied cancellation or a deadline through a direct abort signal. */
  | "input-has-abort-signal"
  /** The original Invocation suppressed writes through dry-run mode. */
  | "input-has-dry-run"
  /** Input preparation changed the prompt before execution. */
  | "input-prompt-changed"

export type AgentInvocationRerunInput =
  | {
    available: true
    /** Invoker Profile selected at start, independent of the resolved invoker identity. */
    invokerProfileId?: string
    prompt: string
  }
  | { available: false, reason: AgentInvocationRerunUnavailableReason }

/**
 * Reads the complete prompt and invoker that the journal captured when the Invocation started.
 * A caller can start a new Invocation with this input. The original record does not change.
 */
export function agentInvocationRerunInput(record: Pick<AgentInvocationRecord, "observations"> & Partial<Pick<AgentInvocationRecord, "status">>): AgentInvocationRerunInput {
  if (record.status !== undefined && !terminalStatus(record.status)) {
    return { available: false, reason: "invocation-not-terminal" }
  }
  const start = record.observations.find(observation => observation.name === "agent.invocation.start")
  const attributes = start?.attributes
  if (!attributes) return { available: false, reason: "input-not-captured" }
  if (attributes[AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE] === true) return { available: false, reason: "input-redacted" }
  if (attributes[INVOKER_PROFILE_TRUNCATED_ATTRIBUTE] === true || attributes[PROMPT_TRUNCATED_ATTRIBUTE] === true
    || (attributes[PROMPT_TRUNCATED_ATTRIBUTE] === undefined && attributes[AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE] === true)) return { available: false, reason: "input-truncated" }
  if (attributes["input.hasData"] === true) return { available: false, reason: "input-has-data" }
  if (attributes["input.hasOptions"] === true) return { available: false, reason: "input-has-options" }
  if (attributes["input.hasMessages"] === true || attributes["input.messages"] !== undefined) return { available: false, reason: "input-has-messages" }
  const prompt = attributes["input.prompt"]
  if (!hasRuntimeType(prompt, "string") || !prompt.trim()) return { available: false, reason: "input-not-captured" }
  if (attributes["input.replay.version"] !== 5 || ["input.promptChanged", "input.hasInvoker", "input.hasResolvedInvoker", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasContext", "input.hasRunMetadata", "input.hasTimeout", "input.hasAbortSignal", "input.hasDryRun"]
    .some(key => !hasRuntimeType(attributes[key], "boolean"))) return { available: false, reason: "replay-metadata-unavailable" }
  if (attributes["input.promptChanged"] === true) return { available: false, reason: "input-prompt-changed" }
  if (attributes["input.hasInvoker"] === true) return { available: false, reason: "input-has-invoker" }
  if (attributes["input.hasResolvedInvoker"] === true) return { available: false, reason: "input-has-invoker" }
  if (attributes["input.hasContext"] === true) return { available: false, reason: "input-has-context" }
  if (attributes["input.hasAbortSignal"] === true) return { available: false, reason: "input-has-abort-signal" }
  if (attributes["input.hasRunMetadata"] === true) return { available: false, reason: "input-has-run-metadata" }
  if (attributes["input.hasTimeout"] === true) return { available: false, reason: "input-has-timeout" }
  if (attributes["input.hasDryRun"] === true) return { available: false, reason: "input-has-dry-run" }
  const invokerProfileId = attributes["agent.invoker.profile.id"]
  return { available: true, ...hasRuntimeType(invokerProfileId, "string") && invokerProfileId ? { invokerProfileId } : {}, prompt }
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
    if (bytes + size + (retained.length ? 1 : 0) > maxBytes && observation.name === "vitehub.agent.configured") {
      candidate = {
        ...observation,
        attributes: {
          ...Object.fromEntries(Object.entries(observation.attributes || {}).filter(([key]) => !isTraceContentAttributeKey(key) && key !== "vitehub.agent.configuration")),
          "vitehub.agent.configurationTruncated": true,
        },
      }
      size = encoder.encode(JSON.stringify(candidate)).byteLength
      if (size + 2 > maxBytes) {
        throw agentDiagnostics.AGENT_R0908({ message: "[vitehub] Agent Invocation observation byte capacity reached; increase observations.maxBytes to retain configuration truncation evidence." })
      }
      while (bytes + size + (retained.length ? 1 : 0) > maxBytes && retained.length > 0) {
        const removed = retained.pop()!
        bytes -= encoder.encode(JSON.stringify(removed)).byteLength + (retained.length ? 1 : 0)
      }
    }
    else if (bytes + size + (retained.length ? 1 : 0) > maxBytes && outcomes.has(observation)) {
      candidate = {
        ...observation,
        attributes: {
          ...Object.fromEntries(Object.entries(observation.attributes || {}).filter(([key]) => !isTraceContentAttributeKey(key) && key !== "vitehub.payload.value")),
          [observation.name === "vitehub.agent.configured" ? "vitehub.agent.configurationTruncated" : AGENT_INVOCATION_OBSERVATION_TRUNCATED_ATTRIBUTE]: true,
          ...(observation.payload?.visibility === "public" ? { "vitehub.payload.visibility": "redacted" } : {}),
        },
        ...(observation.payload?.visibility === "public" ? { payload: { visibility: "redacted" as const } } : {}),
      }
      size = encoder.encode(JSON.stringify(candidate)).byteLength
      const usageRecord = candidate.attributes?.["usage.record"]
      if (bytes + size + (retained.length ? 1 : 0) > maxBytes && isRuntimeRecord(usageRecord)) {
        // Keep canonical totals before dropping bulky per-call and raw evidence.
        const { calls: _calls, raw: _raw, ...summary } = usageRecord
        candidate = { ...candidate, attributes: { ...candidate.attributes, "usage.record": summary } }
        size = encoder.encode(JSON.stringify(candidate)).byteLength
        if (bytes + size + (retained.length ? 1 : 0) > maxBytes) {
          // Arbitrary details and response metadata must not displace measured totals.
          const usage = summary.usage
          const cost = summary.cost
          const scalarUsage = isRuntimeRecord(usage)
            ? Object.fromEntries(["inputTokens", "outputTokens", "totalTokens"].flatMap(key =>
                hasRuntimeType(usage[key], "number") ? [[key, usage[key]]] : []))
            : undefined
          const scalarCost = isRuntimeRecord(cost)
            ? Object.fromEntries(["usd", "estimated"].flatMap(key =>
                hasRuntimeType(cost[key], "string") || hasRuntimeType(cost[key], "boolean") ? [[key, cost[key]]] : []))
            : undefined
          candidate = { ...candidate, attributes: { ...candidate.attributes, "usage.record": {
            ...(scalarUsage ? { usage: scalarUsage } : {}),
            ...(scalarCost ? { cost: scalarCost } : {}),
          } } }
          size = encoder.encode(JSON.stringify(candidate)).byteLength
        }
        if (bytes + size + (retained.length ? 1 : 0) > maxBytes) {
          const { "usage.record": _usage, ...attributes } = candidate.attributes!
          candidate = { ...candidate, attributes }
          size = encoder.encode(JSON.stringify(candidate)).byteLength
        }
      }
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
    ...(input.workflow ? { workflow: { ...input.workflow } } : {}),
    ...(configuredAnnotations
      ? { annotations: mergeConfigurationAnnotations(record.annotations, configuredAnnotations) }
      : {}),
    ...(capabilityIds.length ? { capabilityIds } : {}),
    ...(input.cancelRequestedAt && !record.cancelRequestedAt ? { cancelRequestedAt: input.cancelRequestedAt } : {}),
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
  for (const field of ["channelId", "origin", "threadId"] as const) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    if (value) updated[field] = boundedString(value)
    else delete updated[field]
  }
  if (Object.hasOwn(input, "annotations")) {
    const annotations = normalizeAnnotations(input.annotations)
    if (annotations) updated.annotations = annotations
    else delete updated.annotations
  }
  if (Object.hasOwn(input, "cancelNotEnforcedBy")) {
    const driver = input.cancelNotEnforcedBy ? boundedString(input.cancelNotEnforcedBy) : undefined
    if (driver) updated.cancelNotEnforcedBy = driver
    else delete updated.cancelNotEnforcedBy
  }
  if (Object.hasOwn(input, "cancelWarningOwnerId")) {
    if (input.cancelWarningOwnerId) updated.cancelWarningOwnerId = boundedString(input.cancelWarningOwnerId)
    else delete updated.cancelWarningOwnerId
  }
  if (Object.hasOwn(input, "cancelWarningPending")) {
    if (input.cancelWarningPending) updated.cancelWarningPending = true
    else {
      delete updated.cancelWarningPending
    }
  }
  return updated
}

export function createMemoryAgentInvocationStore(): AgentInvocationStore {
  const claims = new Map<string, { claimId: string, expiresAt: number, token: string }>()
  const supersededClaims = new Map<string, Set<string>>()
  const records = new Map<string, AgentInvocationRecord>()
  let cursor = 0
  return {
    claim(id, claimId, leaseMs, options) {
      const claim = claims.get(id)
      const now = Date.now()
      if (supersededClaims.get(id)?.has(claimId)) return false
      const expected = options?.expectedClaimIds
      const expectedMismatch = expected !== undefined && claim !== undefined
        && claim.claimId !== claimId && !expected.includes(claim.claimId)
      if (expectedMismatch) return false
      const replace = options?.replaceExisting
        || (expected === undefined && options?.replaceClaimToken !== undefined && claim?.token === options.replaceClaimToken)
      const claimConflict = claim !== undefined && claim.claimId !== claimId
      const activeConflict = expected === undefined && claimConflict && claim.expiresAt > now
      if (!records.has(id) || (!replace && activeConflict)) return false
      if (claim && claim.claimId !== claimId) {
        let superseded = supersededClaims.get(id)
        if (!superseded) supersededClaims.set(id, superseded = new Set())
        superseded.add(claim.claimId)
      }
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
    get(id, options) {
      const record = records.get(id)
      if (!record) return undefined
      const cloned = cloneRecord(record)
      if (options?.observationNames) {
        const names = new Set(options.observationNames)
        cloned.observations = cloned.observations.filter(observation => names.has(observation.name))
      }
      return cloned
    },
    getSummary(id) {
      const record = records.get(id)
      if (!record) return
      return cloneSummary(record)
    },
    getClaimToken(id) {
      return claims.get(id)?.token
    },
    list(input = {}) {
      const options = normalizeAgentInvocationListOptions(input, { sequenceCursor: true })
      const { limit, cursor, search } = options
      const agentName = options.agentName?.trim()
      const capabilityId = options.capabilityId?.trim()
      const triggeredBy = options.triggeredBy?.trim()
      const statuses = options.status === undefined
        ? undefined
        : new Set(Array.isArray(options.status) ? options.status : [options.status])
      const before = cursor === undefined ? Number.POSITIVE_INFINITY : Number(cursor)
      const candidates = [...records.values()]
        .filter(record => Number(record.cursor) < before
          && (!agentName || record.agentName === agentName)
          && (!capabilityId || invocationCapabilityIds(record).includes(capabilityId))
          && (!triggeredBy || (hasRuntimeType(record.annotations?.triggeredBy, "string") && record.annotations.triggeredBy.trim() === triggeredBy))
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
    delete(id) {
      const record = records.get(id)
      if (!record) return "not-found"
      if (!terminalStatus(record.status)) return "not-terminal"
      records.delete(id)
      claims.delete(id)
      return "deleted"
    },
    prune(options) {
      // The memory store has no configured retention, so only an explicit cutoff selects records.
      const ids = options.updatedBefore === undefined
        ? []
        : [...records.values()]
            .filter(record => terminalStatus(record.status) && record.updatedAt < options.updatedBefore!)
            .map(record => record.id)
      if (!options.dryRun) {
        for (const id of ids) {
          records.delete(id)
          claims.delete(id)
        }
      }
      return { dryRun: options.dryRun === true, ids }
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
  maxMessageDeltaCharacters: number,
  maxMessageDeltaKeys: number,
): TraceEventLog {
  const journalId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`
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
  const observations = createInvocationObservationStream({ emit, maxMessageDeltaCharacters, maxMessageDeltaKeys })
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const journal = {
    [agentInvocationJournalTraceLogSymbol]: true,
    async append(event: TraceEvent) {
      const auxiliaryTitle = event.attributes?.["vitehub.auxiliary.kind"] === "title"
      const safeEntryPromise = Promise.resolve(createTraceEventLog({ content: auxiliaryTitle ? "metadata" : content }).append(event))
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
        if (content === "metadata" && !auxiliaryTitle) restoreMetadataContentValues(safeEntry, metadataContentValues)
        observations.append(safeEntry)
      }
      catch {}
      return entry
    },
    entries() {
      observations.flush()
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
  if (options.redact !== undefined && !hasRuntimeType(options.redact, "function")) {
    throw agentDiagnostics.AGENT_R0624({ message: "[vitehub] Agent Invocations redact must be a function." })
  }
  if (options.redactError !== undefined && !hasRuntimeType(options.redactError, "function")) {
    throw agentDiagnostics.AGENT_R0624({ message: "[vitehub] Agent Invocations redactError must be a function." })
  }
  const redact = (observation: TraceEventLogEntry): TraceEventLogEntry | undefined => {
    if (!options.redact) return observation
    try {
      const redacted = options.redact(cloneObservation(observation))
      const identity = observationIdentity(observation)
      if (!redacted) return
      const inputRedacted = observation.name === "agent.invocation.start"
        && ["input.prompt", "input.replay.version", "input.promptChanged", "input.hasInvoker", "input.hasResolvedInvoker", "agent.invoker.profile.id", "input.hasData", "input.hasOptions", "input.hasMessages", "input.hasPrompt", "input.hasContext", "input.hasRunMetadata", "input.hasTimeout", "input.hasAbortSignal", "input.hasDryRun"]
          .some(key => observation.attributes?.[key] !== redacted.attributes?.[key])
      return {
        ...redacted,
        attributes: {
          ...redacted.attributes,
          ...(identity !== undefined ? { [AGENT_INVOCATION_OBSERVATION_ID_ATTRIBUTE]: identity } : {}),
          ...(inputRedacted || observation.attributes?.[AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE] === true ? { [AGENT_INVOCATION_INPUT_REDACTED_ATTRIBUTE]: true } : {}),
        },
      }
    }
    catch { return undefined }
  }
  const redactedError = (error: unknown): AgentInvocationRecord["error"] => {
    const details = errorDetails(error)
    if (!details || !options.redactError) return details
    try { return options.redactError(structuredClone(details)) }
    catch { return undefined }
  }
  const configuredObservationLimits = observationLimits(options.observations)
  const content = options.content || "metadata"
  const metadataContent = new Set(options.metadataContent || [])
  if (options.configuration === "content") metadataContent.add("vitehub.agent.configuration")
  const store = options.store
  const invocations: BoundAgentInvocations = {
    [agentInvocationsBrand]: true,
    get supportsDelete() { return hasRuntimeType(store.delete, "function") },
    async [recoverInterruptedAgentInvocationsSymbol](recoveryOptions) {
      return await failInterruptedAgentInvocations(store, recoveryOptions)
    },
    async [bindAgentInvocationsSymbol]<TRuntimeConfig extends AgentRuntimeConfig>(
      context: AgentRuntimeContext<TRuntimeConfig>,
      bindOptions: { agentName?: string, cancellationDriver?: AgentInvocationCancellationDriver, deferClaim?: boolean, terminalTakeover?: boolean, requireNew?: boolean, replaceClaimToken?: string, recoverPending?: boolean } = {},
    ): Promise<AgentInvocationJournal<TRuntimeConfig>> {
      const runId = context.run?.runId || createInvocationId()
      const agentName = bindOptions.agentName || context.agentIdentity?.name
      const recordId = await agentInvocationId(runId, agentName)
      let claimId = createInvocationId()
      let claimConfirmed = false
      let claimUncertain = false
      let claimHandedOff = false
      let claimAttempt = 0
      let claimRenewals = Promise.resolve()
      const pendingClaimIds = new Set<string>()
      let traceId = await boundedIdentity(context.trace?.id || runId)
      const cancellationOwnerId = createInvocationId()
      const annotations = normalizeAnnotations(context.run?.annotations)
      let writes = Promise.resolve()
      let finished = false
      let boundToTerminalRecord = false
      let finishing = false
      let terminalWriteCommitted = false
      let ownsRecord = false
      let claimUnavailable = true
      let limits = configuredObservationLimits
      let observationCount = 0
      let observationsTruncated = false
      let truncationPersisted = false
      let observationSequence = 0
      let created = false
      let heartbeatRenewal: Promise<unknown> = Promise.resolve()
      let workflowDispatchAllowed = false
      let createdNew = false
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
      const cancellation = new AbortController()
      let cancellationDriver = bindOptions.cancellationDriver
      let driverDispatched = false
      let cancelNotEnforcedBy: string | undefined
      let cancellationWarningPrepared = false
      let unregisterCancellation: (() => void) | undefined
      let cancellationPolling: ReturnType<typeof setInterval> | undefined
      let cancellationRegistration: Promise<void> | undefined
      const requestCancellation = (reason: unknown = createAgentInvocationCancellationError(recordId)) => {
        if (!cancellation.signal.aborted) cancellation.abort(reason)
      }
      const readCancellationRequest = (record: Pick<AgentInvocationRecord, "cancelRequestedAt"> | undefined) => {
        if (record?.cancelRequestedAt) requestCancellation()
      }
      const stopCancellationPolling = () => {
        if (cancellationPolling !== undefined) clearInterval(cancellationPolling)
        cancellationPolling = undefined
      }
      const stopWatchingCancellation = () => {
        stopCancellationPolling()
        unregisterCancellation?.()
        unregisterCancellation = undefined
      }
      const pollCancellationRequest = async (initial = false) => {
        if (!unregisterCancellation || finished || cancellation.signal.aborted) return
        const summary = await boundedStoreOperation(() => store.getSummary(recordId))
        if (initial && (!summary || summary === storeOperationTimedOut)) {
          throw agentDiagnostics.AGENT_R0973({ message: summary === storeOperationTimedOut
            ? "[vitehub] Initial Agent Invocation cancellation check timed out."
            : "[vitehub] Initial Agent Invocation cancellation check failed." })
        }
        if (summary && summary !== storeOperationTimedOut) readCancellationRequest(summary)
      }
      const stopHeartbeat = () => {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        heartbeat = undefined
      }
      const startHeartbeat = () => {
        if (finished || !ownsRecord || heartbeat !== undefined) return
        heartbeat = setInterval(() => { heartbeatRenewal = renew() }, CLAIM_RENEW_INTERVAL_MS)
        unrefTimer(heartbeat)
      }
      const ensureCreated = async (): Promise<boolean> => {
        if (created || creationTimedOut) return created
        if (!creationTask) {
          const task = Promise.resolve().then(() => store.create(createInput)).then((result) => {
            if (result) {
              traceId = result.record.traceId
              limits = observationLimits(result.record.observationLimits)
              observationCount = result.record.observations.length
              observationsTruncated = result.record.observationsTruncated === true
                || result.record.observations.some(observation => observation.attributes?.["vitehub.trace.truncated"] === true)
              truncationPersisted = result.record.observationsTruncated === true
              observationSequence = Math.max(observationSequence, ...result.record.observations.map(observation => observation.sequence))
              invocationCapabilityIds(result.record).forEach(capabilityId => observedCapabilityIds.add(capabilityId))
              finished = terminalStatus(result.record.status)
              boundToTerminalRecord = finished
              workflowDispatchAllowed = result.created || (result.record.status === "pending" && result.record.annotations?.[pendingAgentInvocationAnnotation] === true)
              createdNew = result.created
              created = true
              cancellationWarningPrepared = (result.record.cancelWarningPending === true && result.record.cancelWarningOwnerId === cancellationOwnerId)
                || (result.record.cancelNotEnforcedBy !== undefined && result.record.cancelNotEnforcedBy === cancellationDriver?.name)
              readCancellationRequest(result.record)
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
      const renewClaim = async (force = false, rotate = false): Promise<boolean> => {
        if (!await ensureCreated() || (finished && !runningRequested) || (claimHandedOff && !rotate)) return false
        if ((bindOptions.requireNew && !createdNew) || (bindOptions.recoverPending && !workflowDispatchAllowed)) {
          claimUnavailable = false
          return false
        }
        if (!force && pendingClaimIds.size >= 2) {
          claimUnavailable = true
          ownsRecord = false
          stopHeartbeat()
          return false
        }
        const attempt = ++claimAttempt
        const attemptId = claimConfirmed && !claimUncertain && !rotate && pendingClaimIds.size === 0 ? claimId : createInvocationId()
        const expectedClaimIds = [...pendingClaimIds, ...(claimConfirmed ? [claimId] : [])]
        pendingClaimIds.add(attemptId)
        const claimTask = Promise.resolve().then(() => store.claim(recordId, attemptId, CLAIM_LEASE_MS,
          force ? { replaceExisting: true }
            : expectedClaimIds.length ? { expectedClaimIds }
              : bindOptions.replaceClaimToken ? { replaceClaimToken: bindOptions.replaceClaimToken } : undefined))
        const claim = await boundedStoreOperation(() => claimTask)
        if (claim !== true && claim !== false) {
          claimUncertain = true
          // An execution that never started must not leave a late claim blocking recovery.
          void claimTask.then(owned => owned ? store.release(recordId, attemptId) : undefined, () => store.release(recordId, attemptId)).catch(() => {}).finally(() => pendingClaimIds.delete(attemptId))
        } else {
          pendingClaimIds.delete(attemptId)
        }
        if (attempt !== claimAttempt) {
          if (claim === true && attemptId !== claimId) await boundedStoreOperation(() => store.release(recordId, attemptId))
          return false
        }
        if (claim === true) {
          claimId = attemptId
          claimConfirmed = true
          claimUncertain = false
        }
        claimUnavailable = claim !== true && claim !== false
        ownsRecord = claim === true
        if (ownsRecord) {
          const latest = await boundedStoreOperation(() => store.getSummary(recordId))
          if (latest && latest !== storeOperationTimedOut) {
            readCancellationRequest(latest)
            // Only this finalizer's acknowledged terminal write permits subsequent cleanup metadata.
            if (terminalStatus(latest.status) && (!finishing || !terminalWriteCommitted)) {
              finished = true
              if (!terminalWriteCommitted) {
                boundToTerminalRecord = true
                requestCancellation()
                stopCancellationPolling()
                // A custom callback can continue after abort, so retain its warning until it returns.
                if (!cancelNotEnforcedBy) stopWatchingCancellation()
              }
            }
          }
        }
        if (ownsRecord && finished) {
          if (!cancelNotEnforcedBy) stopWatchingCancellation()
          await boundedStoreOperation(() => store.release(recordId, attemptId))
          ownsRecord = false
          stopHeartbeat()
          return false
        }
        if (ownsRecord) startHeartbeat()
        else stopHeartbeat()
        return ownsRecord
      }
      const renew = (force = false, rotate = false): Promise<boolean> => {
        const task = claimRenewals.then(() => renewClaim(force, rotate))
        claimRenewals = task.then(() => {}, () => {})
        return task
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
      createInput.cancelWarningOwnerId = cancellationOwnerId
      if (bindOptions.cancellationDriver?.enforced === false) {
        createInput.cancelWarningPending = true
      }
      await ensureCreated()
      if (!bindOptions.deferClaim) await renew()
      const baseTraceLog = context.traceLog || createTraceEventLog()
      const update = async (input: AgentInvocationStoreUpdateInput, force = false): Promise<boolean> => {
        let updated = false
        await write(async () => {
          if (!await renew(force)) return
          const operation = Promise.resolve().then(() => store.update(recordId, input, claimId)).then(result => {
            if (result && input.status && terminalStatus(input.status) && result.status === input.status) terminalWriteCommitted = true
            return result
          })
          const result = await boundedStoreOperation(() => operation)
          updated = result !== undefined && result !== storeOperationTimedOut
          if (result !== undefined && result !== storeOperationTimedOut) readCancellationRequest(result)
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
              readCancellationRequest(updated)
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
        while (!persisted && !boundToTerminalRecord && Date.now() < deadline) {
          await write(async () => {
            if (boundToTerminalRecord || !await ensureCreated()) return
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
      const observe = (entry: TraceEventLogEntry) => {
        if (entry.attributes?.["vitehub.auxiliary.kind"] === "title"
          && (entry.name === "agent.message.delta" || entry.name === "vitehub.agent.configured")) return
        // Redact once here: every streamed persistence path, including late recovery, starts from this observation.
        const observation = redact(entry)
        if (!observation) return
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
        get createdNew() { return createdNew },
        get claimStatus() { return ownsRecord ? "owned" : claimUnavailable ? "unavailable" : "conflict" },
        async getWorkflowDispatchAttempted() {
          const record = await boundedStoreOperation(() => store.getSummary(recordId))
          if (!record || record === storeOperationTimedOut) return undefined
          const attempted = record.annotations?.[workflowDispatchAttemptedAnnotation]
          return attempted === true || attempted === false ? attempted : undefined
        },
        async handoffClaim(options = {}) {
          stopHeartbeat()
          await heartbeatRenewal
          const record = await boundedStoreOperation(() => store.get(recordId))
          if (!record || record === storeOperationTimedOut || terminalStatus(record.status)) return undefined
          if (!await renew(false, true)) return undefined
          claimHandedOff = true
          stopHeartbeat()
          if (options.workflowDispatch) {
            let attempted = false
            await write(async () => {
              const current = await boundedStoreOperation(() => store.get(recordId))
              if (!current || current === storeOperationTimedOut || terminalStatus(current.status)) return
              const annotations = { [workflowDispatchAttemptedAnnotation]: true, ...current.annotations }
              annotations[workflowDispatchAttemptedAnnotation] = true
              const updated = await boundedStoreOperation(() => store.update(recordId, {
                annotations,
                timestamp: new Date().toISOString(),
              }, claimId))
              attempted = updated !== undefined && updated !== storeOperationTimedOut
                && updated.annotations?.[workflowDispatchAttemptedAnnotation] === true
            })
            if (!attempted) return undefined
          }
          const token = await boundedStoreOperation(() => store.getClaimToken(recordId))
          return token === storeOperationTimedOut ? undefined : token
        },
        async prepareWorkflowDispatch(binding) {
          return await update({ workflow: binding, timestamp: new Date().toISOString() })
        },
        async confirmWorkflowDispatch(binding) {
          let confirmed = false
          // Renewing here would rotate the token already sent to the worker.
          await write(async () => {
            let record = await boundedStoreOperation(() => store.get(recordId))
            if (!record || record === storeOperationTimedOut) return
            if (binding) {
              const associated = await boundedStoreOperation(() => store.update(recordId, {
                workflow: binding,
                timestamp: new Date().toISOString(),
              }, claimId))
              if (!associated || associated === storeOperationTimedOut) return
              record = associated
            }
            const updated = await boundedStoreOperation(() => store.update(recordId, {
              annotations: { ...record.annotations, [pendingAgentInvocationAnnotation]: false },
              timestamp: new Date().toISOString(),
            }, claimId))
            confirmed = updated !== undefined && updated !== storeOperationTimedOut
          })
          return confirmed
        },
        async releaseClaim() {
          stopHeartbeat()
          if (ownsRecord) await write(() => boundedStoreOperation(() => store.release(recordId, claimId)))
          ownsRecord = false
        },
        abortSignal: cancellation.signal,
        configuration: options.configuration,
        get traceId() { return created ? traceId : undefined },
        async ready() {
          if (creationTask) await boundedStoreOperation(() => creationTask!)
        },
        context: {
          ...context,
          run: { ...context.run, runId },
          trace: context.trace || { id: runId },
          traceLog: journalTraceLog(baseTraceLog, observe, () => ++observationSequence, content, metadataContent, limits.maxStringLength, limits.maxCount),
        },
        async finish(status, error) {
          if (finished) {
            stopWatchingCancellation()
            return
          }
          if (finishing) return
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
            runningPersisted = await update({ cancelNotEnforcedBy: cancelNotEnforcedBy ?? null, cancelWarningPending: cancellationDriver?.enforced === false && !driverDispatched, cancelWarningOwnerId: cancellationOwnerId, status: "running", timestamp: new Date().toISOString() })
          }
          const failure = redactedError(error)
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
            cancelNotEnforcedBy: cancelNotEnforcedBy ?? null,
            cancelWarningPending: false,
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
                cancelNotEnforcedBy: cancelNotEnforcedBy ?? null,
                cancelWarningPending: false,
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
            stopWatchingCancellation()
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
          if (await finishOnce() || finished || terminalRetry) {
            if (finished) stopWatchingCancellation()
            return
          }
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
              stopWatchingCancellation()
              stopHeartbeat()
              if (ownsRecord) await write(() => boundedStoreOperation(() => store.release(recordId, claimId)))
              ownsRecord = false
            }
            else stopWatchingCancellation()
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
          if (finished) return false
          runningRequested = true
          const markRunning = async () => {
            // Clear the replay reservation before any Driver work starts. If a
            // later terminal update is lost, the pending record still carries
            // proof that execution began and cannot be retried as preparation.
            const annotations = normalizeAnnotations(context.run?.annotations) || {}
            // SAFETY: The runtime context is extended with the private inherited claim marker by the claim handoff path.
            const inheritedClaim = (context as AgentRuntimeContext & { [inheritedAgentInvocationClaim]?: string })[inheritedAgentInvocationClaim]
            if (inheritedClaim) annotations[pendingAgentInvocationAnnotation] = false
            runningPersisted = await update({
              cancelNotEnforcedBy: cancelNotEnforcedBy ?? null,
              cancelWarningPending: cancellationDriver?.enforced === false && !driverDispatched,
              cancelWarningOwnerId: cancellationOwnerId,
              status: "running",
              annotations,
              timestamp: new Date().toISOString(),
            })
            if (runningPersisted && cancellationDriver?.enforced === false) cancellationWarningPrepared = true
            return runningPersisted
          }
          if (await markRunning()) return true
          if (cancellationDriver?.enforced === false && !cancellationWarningPrepared) {
            throw agentDiagnostics.AGENT_R0973({ message: "[vitehub] Initial custom Driver cancellation state could not be persisted." })
          }
          if (runningRetry) return false
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
          return false
        },
        driverStarted() {
          if (finished || finishing || driverDispatched) return
          driverDispatched = true
          if (!cancellationDriver || cancellationDriver.enforced) return
          cancelNotEnforcedBy = cancellationDriver.name
          const retry = (async () => {
            const deadline = Date.now() + TERMINAL_RETRY_TIMEOUT_MS
            while (!finished && !finishing) {
              if (await update({ cancelNotEnforcedBy, cancelWarningPending: false, status: "running", timestamp: new Date().toISOString() })) return
              if (Date.now() >= deadline) return
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, TERMINAL_RETRY_INTERVAL_MS)
                unrefTimer(timer)
              })
            }
          })()
          registerAgentInvocationRecovery(context, retry)
        },
        async setAnnotations(annotations) {
          if (finished || finishing) return
          await update({ annotations: normalizeAnnotations(annotations), timestamp: new Date().toISOString() })
        },
        async setRunMetadata(run) {
          if (finished || finishing) return false
          return await update({
            annotations: normalizeAnnotations(run.annotations),
            channelId: run.channelId,
            origin: run.origin,
            threadId: run.threadId,
            timestamp: new Date().toISOString(),
          })
        },
        async watchCancellation(driver) {
          if (finished || finishing) return
          if (unregisterCancellation) return await cancellationRegistration
          cancellationDriver = driver
          unregisterCancellation = registerAgentInvocationCancellation(store, recordId, { abort: requestCancellation, driver: () => driverDispatched ? driver : undefined, ownerId: cancellationOwnerId })
          // A lost lease stops writes, but the stale Driver still needs journal cancellation.
          cancellationPolling = setInterval(() => { void pollCancellationRequest().catch(() => undefined) }, CLAIM_RENEW_INTERVAL_MS)
          unrefTimer(cancellationPolling)
          cancellationRegistration = pollCancellationRequest(true)
          await cancellationRegistration
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
      const entry = await createTraceEventLog({ content }).append(event)
      if (content === "metadata") restoreMetadataContentValues(entry, metadataContentValues)
      const observation = redact(entry)
      if (!observation) return existing
      const prepared = await boundedJournalObservation({
        ...observation,
        ...(observation.trace ? { trace: { ...observation.trace, id: existing.traceId } } : {}),
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
    async delete(id) {
      assertInvocationId(id)
      if (!store.delete) {
        throw agentDiagnostics.AGENT_R0932({ message: "[vitehub] This Agent Invocation store does not support deletion. Implement store.delete() or use a ViteHub store." })
      }
      return await store.delete(id)
    },
    async prune(pruneOptions = {}) {
      if (!store.prune) {
        throw agentDiagnostics.AGENT_R0932({ message: "[vitehub] This Agent Invocation store does not support pruning. Implement store.prune() or use a ViteHub store." })
      }
      const { dryRun, olderThanMs } = pruneOptions
      if (olderThanMs !== undefined && (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)) {
        throw agentDiagnostics.AGENT_R0929({ message: "[vitehub] Agent Invocation prune olderThanMs must be a non-negative safe integer." })
      }
      const cutoff = olderThanMs === undefined ? undefined : new Date(Date.now() - olderThanMs)
      if (cutoff && Number.isNaN(cutoff.getTime())) {
        throw agentDiagnostics.AGENT_R0929({ message: "[vitehub] Agent Invocation prune olderThanMs must produce a cutoff within JavaScript's Date range." })
      }
      return await store.prune({
        ...(dryRun ? { dryRun: true } : {}),
        ...(cutoff === undefined ? {} : { updatedBefore: cutoff.toISOString() }),
      })
    },
    async cancel(id) {
      assertInvocationId(id)
      const terminalResult = (record: AgentInvocationSummary, local?: ReturnType<typeof abortLocalAgentInvocation>): AgentInvocationCancelResult => {
        const localOwnsRecord = record.cancelWarningOwnerId !== undefined && local?.ownerIds.includes(record.cancelWarningOwnerId)
        const notEnforcedBy = record.cancelNotEnforcedBy || (localOwnsRecord ? local?.notEnforcedByOwners?.find(entry => entry.ownerId === record.cancelWarningOwnerId)?.name : undefined)
        return {
          ...(localOwnsRecord ? { delivery: "local" as const } : {}),
          id,
          ...(notEnforcedBy ? { notEnforcedBy } : {}),
          outcome: "terminal",
          status: record.status,
        }
      }
      let summary: AgentInvocationSummary | undefined
      try {
        summary = await store.getSummary(id)
      }
      catch (error) {
        abortLocalAgentInvocation(store, id, createAgentInvocationCancellationError(id))
        throw error
      }
      if (!summary) return { id, outcome: "not-found" }
      if (terminalStatus(summary.status)) {
        return terminalResult(summary, abortLocalAgentInvocation(store, id, createAgentInvocationCancellationError(id)))
      }
      const timestamp = new Date().toISOString()
      // Persist the request first, so a run in another process and a later bind of this record read it.
      let flagged: AgentInvocationRecord | undefined
      let local: ReturnType<typeof abortLocalAgentInvocation>
      try {
        flagged = await store.update(id, { cancelRequestedAt: timestamp, timestamp })
      }
      finally {
        // A failed durable request must still signal work in this process, while the write error propagates.
        local = abortLocalAgentInvocation(store, id, createAgentInvocationCancellationError(id))
      }
      let current = await store.getSummary(id) ?? flagged
      if (!current) return { id, outcome: "not-found" }
      if (terminalStatus(current.status)) return terminalResult(current, local)
      // Only the matching execution owner can verify whether its custom Driver has dispatched.
      const cancelWarningOwnerId = current.cancelWarningOwnerId
      const ownerNotEnforcedBy = cancelWarningOwnerId === undefined
        ? undefined
        : local.notEnforcedByOwners?.find(entry => entry.ownerId === cancelWarningOwnerId)?.name
      const localOwnsRecord = cancelWarningOwnerId !== undefined && local.ownerIds.includes(cancelWarningOwnerId)
      if (localOwnsRecord) {
        const notEnforcedBy = current.cancelNotEnforcedBy || ownerNotEnforcedBy
        return {
          delivery: "local",
          id,
          ...(notEnforcedBy ? { notEnforcedBy } : {}),
          outcome: "requested",
          status: current.status,
        }
      }
      // Lease availability and a pending record cannot prove that no Driver started.
      // The durable request is terminalized by an execution owner that observes it.
      current = await store.getSummary(id)
      if (!current) return { id, outcome: "not-found" }
      const verificationDeadline = Date.now() + CANCELLATION_VERIFICATION_TIMEOUT_MS
      while (!terminalStatus(current.status) && current.cancelWarningPending && !current.cancelNotEnforcedBy) {
        if (Date.now() >= verificationDeadline) {
          throw agentDiagnostics.AGENT_R0974({ message: `[vitehub] Cancellation was recorded for Agent Invocation ${JSON.stringify(id)}, but its Driver dispatch state could not be verified within five seconds.` })
        }
        await new Promise<void>(resolve => setTimeout(resolve, CANCELLATION_VERIFICATION_INTERVAL_MS))
        const summary = await boundedStoreOperation(() => store.getSummary(id), Math.min(STORE_OPERATION_TIMEOUT_MS, Math.max(0, verificationDeadline - Date.now())))
        if (summary && summary !== storeOperationTimedOut) current = summary
      }
      if (terminalStatus(current.status)) return terminalResult(current, local)
      if (!current.cancelRequestedAt) return { id, outcome: "unavailable", status: current.status }
      return {
        delivery: current.cancelWarningOwnerId !== undefined && local.ownerIds.includes(current.cancelWarningOwnerId) ? "local" : "journal",
        id,
        ...(current.cancelNotEnforcedBy ? { notEnforcedBy: current.cancelNotEnforcedBy } : {}),
        outcome: "requested",
        status: current.status,
      }
    },
    async get(id, options) {
      assertInvocationId(id)
      const record = await store.get(id, options)
      if (!record || !options?.observationNames) return record
      return { ...record, observations: record.observations.filter(entry => options.observationNames!.includes(entry.name)) }
    },
    async getByRunId(runId, agentName) {
      return await store.get(await agentInvocationId(runId, agentName))
    },
    async getSummary(id) {
      assertInvocationId(id)
      return await store.getSummary(id)
    },
    async list(options = {}) {
      const normalized = normalizeAgentInvocationListOptions(options)
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
    async listTriggeredBy(agentName) {
      const selectedAgent = agentName?.trim()
      if (store.listTriggeredBy) {
        return [...new Set((await store.listTriggeredBy(selectedAgent))
          .map(triggeredBy => triggeredBy.trim())
          .filter(Boolean))]
          .sort()
      }
      const triggeredBy = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await store.list({ ...(selectedAgent ? { agentName: selectedAgent } : {}), cursor, limit: MAX_LIST_LIMIT })
        for (const invocation of page.invocations) {
          const label = invocation.annotations?.triggeredBy
          if (hasRuntimeType(label, "string") && label.trim()) triggeredBy.add(label.trim())
        }
        cursor = page.cursor
      } while (cursor)
      return [...triggeredBy].sort()
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
  options?: { agentName?: string, cancellationDriver?: AgentInvocationCancellationDriver, deferClaim?: boolean, terminalTakeover?: boolean, requireNew?: boolean, replaceClaimToken?: string, recoverPending?: boolean },
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

/** Fails interrupted invocations in a journal created by defineAgentInvocations(). */
export async function recoverInterruptedAgentInvocations(
  invocations: AgentInvocations,
  options: Parameters<typeof failInterruptedAgentInvocations>[1],
): Promise<number> {
  // SAFETY: Invocation event normalization establishes the asserted invocation contract.
  const recover = (invocations as Partial<BoundAgentInvocations>)[recoverInterruptedAgentInvocationsSymbol]
  if (!hasRuntimeType(recover, "function")) {
    throw agentDiagnostics.AGENT_R0627({ message: "[vitehub] defineAgent({ invocations }) requires a definition created by defineAgentInvocations()." })
  }
  return await recover.call(invocations, options)
}
