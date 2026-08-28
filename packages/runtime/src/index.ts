import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"
import { ViteHubError } from "./errors.ts"

export {
  normalizeRuntimeDiagnosticError,
  type RuntimeDiagnosticError,
  type RuntimeDiagnosticErrorOptions,
  type RuntimeDiagnosticEvent,
  type RuntimeDiagnosticLevel,
  type RuntimeDiagnosticReporter,
  type RuntimeResourceInspector,
  type RuntimeResourceObservation,
  type RuntimeResourceScope,
  type RuntimeResourceSnapshot,
  type RuntimeResourceSupport,
  type RuntimeResourceUnit,
} from "./diagnostics.ts"

export {
  getViteHubErrorShape,
  isViteHubError,
  ViteHubError,
  type ViteHubErrorDetail,
  type ViteHubErrorDetails,
  type ViteHubErrorOptions,
  type ViteHubErrorShape,
} from "./errors.ts"

export type MaybePromise<T> = T | Promise<T>

export interface ExecutionAuthority {
  readonly credentials: "ambient" | "none" | "provisioned" | "unknown"
  readonly environment: "ambient" | "none" | "selected" | "unknown"
  readonly filesystem: {
    readonly access: "none" | "read-only" | "read-write" | "unknown"
    readonly scope: "host" | "none" | "sandbox" | "unknown" | "workspace"
  }
  readonly isolation: "container" | "microvm" | "none" | "process" | "unknown"
  readonly network: "none" | "restricted" | "unrestricted" | "unknown"
  readonly processes: "arbitrary" | "none" | "restricted" | "unknown"
}

export const noExecutionAuthority: ExecutionAuthority = Object.freeze({
  credentials: "none",
  environment: "none",
  filesystem: Object.freeze({ access: "none", scope: "none" }),
  isolation: "none",
  network: "none",
  processes: "none",
}) satisfies ExecutionAuthority

export const unknownExecutionAuthority: ExecutionAuthority = Object.freeze({
  credentials: "unknown",
  environment: "unknown",
  filesystem: Object.freeze({ access: "unknown", scope: "unknown" }),
  isolation: "unknown",
  network: "unknown",
  processes: "unknown",
}) satisfies ExecutionAuthority

export function isExecutionAuthority(value: unknown): value is ExecutionAuthority {
  if (!value || !hasRuntimeType(value, "object") || Array.isArray(value)) return false
  // SAFETY: Runtime Capability normalization establishes the asserted host contract.
  const authority = value as Record<string, unknown>
  const filesystem = authority.filesystem
  if (!filesystem || !hasRuntimeType(filesystem, "object") || Array.isArray(filesystem)) return false
  // SAFETY: Runtime Capability normalization establishes the asserted host contract.
  const files = filesystem as Record<string, unknown>
  return hasRuntimeType(authority.credentials, "string")
    && ["ambient", "none", "provisioned", "unknown"].includes(authority.credentials)
    && hasRuntimeType(authority.environment, "string")
    && ["ambient", "none", "selected", "unknown"].includes(authority.environment)
    && hasRuntimeType(files.access, "string")
    && ["none", "read-only", "read-write", "unknown"].includes(files.access)
    && hasRuntimeType(files.scope, "string")
    && ["host", "none", "sandbox", "unknown", "workspace"].includes(files.scope)
    && hasRuntimeType(authority.isolation, "string")
    && ["container", "microvm", "none", "process", "unknown"].includes(authority.isolation)
    && hasRuntimeType(authority.network, "string")
    && ["none", "restricted", "unrestricted", "unknown"].includes(authority.network)
    && hasRuntimeType(authority.processes, "string")
    && ["arbitrary", "none", "restricted", "unknown"].includes(authority.processes)
}

export function normalizeExecutionAuthority(value: unknown): ExecutionAuthority {
  if (!isExecutionAuthority(value)) {
    throw new TypeError("[vitehub] Invalid execution authority descriptor.")
  }
  if (
    hasCanonicalFrozenProperties(value, ["credentials", "environment", "filesystem", "isolation", "network", "processes"])
    && hasCanonicalFrozenProperties(value.filesystem, ["access", "scope"])
  ) return value
  return Object.freeze({
    credentials: value.credentials,
    environment: value.environment,
    filesystem: Object.freeze({
      access: value.filesystem.access,
      scope: value.filesystem.scope,
    }),
    isolation: value.isolation,
    network: value.network,
    processes: value.processes,
  })
}

function hasCanonicalFrozenProperties(value: unknown, keys: readonly string[]): boolean {
  if (!isRuntimeObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Object.isFrozen(value) || (prototype !== Object.prototype && prototype !== null)) return false
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => !hasRuntimeType(key, "string") || !keys.includes(key))) return false
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
  })
}

export type RuntimeWaitUntil = (task: Promise<unknown>) => void

export interface RuntimeWaitUntilController {
  flushWaitUntil(): Promise<void>
  waitUntil: RuntimeWaitUntil
}

export interface TraceContext {
  id: string
  parentId?: string
  sampled?: boolean
}

export type TraceActivityOwner = "agent" | "vitehub"
export type TraceActivityPhase = "delivery" | "execution" | "setup" | "teardown"

export interface TraceActivityContext {
  owner: TraceActivityOwner
  phase: TraceActivityPhase
}

export type TracePayloadVisibility = "private" | "public" | "redacted" | "summary"

export type TraceEventPayload =
  | { value: unknown, visibility: "public" }
  | { summary: string, visibility: "summary" }
  | { visibility: "redacted" }
  | { visibility: "private" }

export type TraceEventContentPolicy = "content" | "metadata"
export type TraceRunStatus = "completed" | "failed" | "running"
export type TraceStepStatus = "completed" | "failed" | "running"

export interface TraceEvent {
  activity?: TraceActivityContext
  attributes?: Record<string, unknown>
  name: string
  payload?: TraceEventPayload
  timestamp?: Date | string
  trace?: TraceContext
  type: "approval" | "capability" | "error" | "lifecycle" | "policy" | "run"
}

export interface TraceEventLogEntry extends TraceEvent {
  sequence: number
  timestamp: string
}

export interface TraceEventLog {
  append(event: TraceEvent): MaybePromise<TraceEventLogEntry>
  entries(): readonly TraceEventLogEntry[]
}

export interface TraceEventLogOptions {
  content?: TraceEventContentPolicy
  onEntry?: (entry: TraceEventLogEntry) => MaybePromise<void>
}

export interface TraceStepView {
  attributes?: Record<string, unknown>
  durationMs?: number
  endTime?: string
  events: TraceEventLogEntry[]
  id: string
  name: string
  startTime: string
  status: TraceStepStatus
  type: TraceEvent["type"]
}

export interface TraceRunView {
  durationMs?: number
  endTime?: string
  events: TraceEventLogEntry[]
  id: string
  startTime: string
  status: TraceRunStatus
  steps: TraceStepView[]
}

export interface OpenTelemetrySpanView {
  attributes?: Record<string, unknown>
  endTime?: string
  events?: OpenTelemetrySpanEventView[]
  name: string
  parentSpanId?: string
  spanId: string
  startTime: string
  status: { code: "ERROR" | "OK" | "UNSET", message?: string }
  traceId: string
}

export interface OpenTelemetrySpanEventView {
  attributes?: Record<string, unknown>
  name: string
  time: string
}

export interface OpenTelemetryLogRecordView {
  attributes?: Record<string, unknown>
  eventName: string
  severityNumber?: number
  severityText?: string
  spanId: string
  time: string
  traceId: string
}

export interface OpenTelemetrySpanViewOptions {
  content?: TraceEventContentPolicy
}

export interface RuntimeHostContext<TRuntimeConfig = Record<string, unknown>> {
  capabilities?: RuntimeCapabilities
  cloudflare?: {
    context?: unknown
    durableObjectStateName?: string
    env?: Record<string, unknown>
  }
  event?: unknown
  memo<T>(key: string, create: () => T): T
  platform?: string
  request?: Request
  runtime: string
  runtimeConfig?: TRuntimeConfig
  trace?: TraceContext
  traceLog?: TraceEventLog
  vercel?: {
    waitUntil?: RuntimeWaitUntil
  }
  flushWaitUntil?: () => Promise<void>
  waitUntil: RuntimeWaitUntil
}

export type ExecutionContext<TRuntimeConfig = Record<string, unknown>> =
  RuntimeHostContext<TRuntimeConfig> & {
    runtimeConfig: TRuntimeConfig
  }

export type ResolvedRuntimeHostContext<TRuntimeConfig = Record<string, unknown>> =
  ExecutionContext<TRuntimeConfig>

export interface CapabilityHandle<TKind extends string = string, TValue = unknown> {
  kind: TKind
  name?: string
  value: TValue
}

export type RuntimeCapabilityHandle<TKind extends string = string, TValue = unknown> =
  CapabilityHandle<TKind, TValue>

export type RuntimeCapabilities = Record<string, CapabilityHandle | unknown>

export interface CapabilityDefinition<TKind extends string = string, TValue = unknown> {
  handle: CapabilityHandle<TKind, TValue>
  resolve(context: ExecutionContext): MaybePromise<CapabilityHandle<TKind, TValue>>
}

export interface Resolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> {
  resolve(context: TContext): MaybePromise<T>
}

export type MaybeResolvable<T, TContext extends RuntimeHostContext<any> = RuntimeHostContext> =
  | T
  | Resolvable<T, TContext>
  | ((context: TContext) => MaybePromise<T>)

export interface PolicyContext {
  capability?: string
  input?: unknown
  operation?: string
  runtime?: string
  subject?: unknown
  trace?: TraceContext
}

export type PolicyDecision = "allow" | "deny" | "require-approval" | "retryable-failure"

export type CapabilityPolicy = PolicyDecision | ((context: PolicyContext) => MaybePromise<PolicyDecision>)

export type ApprovalState = "proposed" | "awaiting-approval" | "approved" | "denied" | "executing" | "completed" | "failed"

export interface ApprovalRequest<TInput = unknown> {
  id: string
  capability?: string
  input?: TInput
  reason?: string
  state: Extract<ApprovalState, "awaiting-approval" | "proposed">
  trace?: TraceContext
}

export interface ApprovalDecision {
  approved: boolean
  decidedAt?: Date | string
  reason?: string
  requestId: string
  state: Extract<ApprovalState, "approved" | "denied">
}

export interface RunLifecycleHooks<TContext extends RuntimeHostContext<any> = RuntimeHostContext> {
  approval?: (request: ApprovalRequest, context: TContext) => MaybePromise<void>
  error?: (error: unknown, context: TContext) => MaybePromise<void>
  finish?: (context: TContext) => MaybePromise<void>
  request?: (context: TContext) => MaybePromise<void>
  trace?: (event: TraceEvent, context: TContext) => MaybePromise<void>
}

const contentAttributeKeys = new Set([
  "args",
  "body",
  "content",
  "data",
  "input",
  "message",
  "messages",
  "output",
  "payload",
  "progress",
  "prompt",
  "raw",
  "request",
  "response",
  "result",
  "text",
  "title",
])

export function isTraceContentAttributeKey(key: string): boolean {
  if (key === "error.message") return false
  if (contentAttributeKeys.has(key)) return true
  return key.split(".").some((part, index) => index > 0 && contentAttributeKeys.has(part))
}

function metadataValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || !hasRuntimeType(value, "object")) return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) {
    const next = value.map(child => metadataValue(child, seen))
    seen.delete(value)
    return next
  }
  const omitted: string[] = []
  let entries: [string, unknown][]
  try {
    entries = Object.entries(value)
  }
  catch {
    seen.delete(value)
    return undefined
  }
  const next = Object.fromEntries(entries.flatMap(([key, child]) => {
    if (isTraceContentAttributeKey(key)) {
      omitted.push(key)
      return []
    }
    return [[key, metadataValue(child, seen)]]
  }))
  seen.delete(value)
  if (omitted.length) next["content.omitted"] = omitted
  return next
}

function timestamp(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (hasRuntimeType(value, "string")) return value
  return new Date().toISOString()
}

function metadataAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  const omitted: string[] = []
  const next = Object.fromEntries(Object.entries(attributes).flatMap(([key, value]) => {
    if (isTraceContentAttributeKey(key)) {
      omitted.push(key)
      return []
    }
    return [[key, metadataValue(value)]]
  }))
  if (omitted.length) next["content.omitted"] = omitted
  return Object.keys(next).length ? next : undefined
}

function normalizedTraceActivity(activity: TraceActivityContext | undefined): TraceActivityContext | undefined {
  if (!activity || !hasRuntimeType(activity, "object")) return
  try {
    if (Array.isArray(activity)) return
    const owner = Object.getOwnPropertyDescriptor(activity, "owner")
    const phase = Object.getOwnPropertyDescriptor(activity, "phase")
    if (!owner || !("value" in owner) || !phase || !("value" in phase)) return
    if (owner.value !== "agent" && owner.value !== "vitehub") return
    if (!["delivery", "execution", "setup", "teardown"].includes(phase.value)) return
    return { owner: owner.value, phase: phase.value }
  }
  catch {
    return
  }
}

function isSharedArrayBuffer(value: unknown): boolean {
  if (!value || !hasRuntimeType(value, "object")) return false
  const constructor = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer")?.value
  if (hasRuntimeType(constructor, "function") && value instanceof constructor) return true
  return Object.prototype.toString.call(value) === "[object SharedArrayBuffer]"
}

function containsSharedArrayBuffer(value: unknown, seen = new Set<object>()): boolean {
  if (!value || !hasRuntimeType(value, "object")) return false
  if (isSharedArrayBuffer(value)) return true
  // SAFETY: The runtime guard below verifies this optional host constructor before instantiation checks.
  const WebAssemblyMemory = (globalThis as typeof globalThis & {
    WebAssembly?: { Memory?: abstract new (...args: never[]) => { buffer: ArrayBufferLike } }
  }).WebAssembly?.Memory
  if (WebAssemblyMemory && value instanceof WebAssemblyMemory) {
    return isSharedArrayBuffer(value.buffer)
  }
  if (seen.has(value)) return false
  seen.add(value)
  if (ArrayBuffer.isView(value)) return containsSharedArrayBuffer(value.buffer, seen)
  if (value instanceof Map) {
    return [...value].some(([key, entry]) => containsSharedArrayBuffer(key, seen) || containsSharedArrayBuffer(entry, seen))
  }
  if (value instanceof Set) return [...value].some(entry => containsSharedArrayBuffer(entry, seen))
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor && containsSharedArrayBuffer(descriptor.value, seen)
  })
}

function containsEnumerableSymbol(value: unknown, seen = new Set<object>()): boolean {
  if (!value || !hasRuntimeType(value, "object") || seen.has(value)) return false
  seen.add(value)
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && hasRuntimeType(key, "symbol")
  })) return true
  if (value instanceof Map) {
    return [...value].some(([key, entry]) => containsEnumerableSymbol(key, seen) || containsEnumerableSymbol(entry, seen))
  }
  if (value instanceof Set) return [...value].some(entry => containsEnumerableSymbol(entry, seen))
  return keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable) return false
    return "value" in descriptor && containsEnumerableSymbol(descriptor.value, seen)
  })
}

function normalizedTracePayload(payload: TraceEventPayload | undefined): TraceEventPayload | undefined {
  if (payload === undefined) return
  if (!payload || !hasRuntimeType(payload, "object")) return { visibility: "private" }
  try {
    if (Array.isArray(payload)) return { visibility: "private" }
    const visibility = Object.getOwnPropertyDescriptor(payload, "visibility")
    if (!visibility || !("value" in visibility)) return { visibility: "private" }
    if (visibility.value === "public") {
      const value = Object.getOwnPropertyDescriptor(payload, "value")
      if (value && "value" in value && !containsEnumerableSymbol(value.value)) {
        const snapshot = structuredClone(value.value)
        if (!containsSharedArrayBuffer(snapshot)) return { value: snapshot, visibility: "public" }
      }
    }
    if (visibility.value === "summary") {
      const summary = Object.getOwnPropertyDescriptor(payload, "summary")
      if (summary && "value" in summary && hasRuntimeType(summary.value, "string")) {
        return { summary: summary.value, visibility: "summary" }
      }
    }
    if (visibility.value === "redacted") return { visibility: "redacted" }
  }
  catch {
    return { visibility: "private" }
  }
  return { visibility: "private" }
}

function traceEventAttributes(
  event: Pick<TraceEvent, "activity" | "attributes" | "payload">,
  content: TraceEventContentPolicy,
): Record<string, unknown> | undefined {
  const activity = normalizedTraceActivity(event.activity)
  const payload = normalizedTracePayload(event.payload)
  const source = { ...event.attributes }
  delete source["vitehub.activity.owner"]
  delete source["vitehub.activity.phase"]
  delete source["vitehub.payload.summary"]
  delete source["vitehub.payload.value"]
  delete source["vitehub.payload.visibility"]
  if (Array.isArray(source["content.omitted"])) {
    const omitted = source["content.omitted"].filter(key => hasRuntimeType(key, "string") && ![
      "vitehub.activity.owner",
      "vitehub.activity.phase",
      "vitehub.payload.summary",
      "vitehub.payload.value",
      "vitehub.payload.visibility",
    ].includes(key))
    if (omitted.length) source["content.omitted"] = omitted
    else delete source["content.omitted"]
  }
  const attributes = content === "metadata" ? metadataAttributes(source) : source
  const next: Record<string, unknown> = { ...attributes }
  if (activity) {
    next["vitehub.activity.owner"] = activity.owner
    next["vitehub.activity.phase"] = activity.phase
  }
  if (payload) {
    next["vitehub.payload.visibility"] = payload.visibility
    if (payload.visibility === "public") next["vitehub.payload.value"] = payload.value
    if (payload.visibility === "summary") next["vitehub.payload.summary"] = payload.summary
  }
  return Object.keys(next).length ? next : undefined
}

function aggregateTraceAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  const next = { ...attributes }
  delete next["vitehub.activity.owner"]
  delete next["vitehub.activity.phase"]
  delete next["vitehub.payload.summary"]
  delete next["vitehub.payload.value"]
  delete next["vitehub.payload.visibility"]
  return Object.keys(next).length ? next : undefined
}

function stepTraceAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  const next = { ...attributes }
  delete next["vitehub.activity.owner"]
  delete next["vitehub.activity.phase"]
  return Object.keys(next).length ? next : undefined
}

function normalizeTraceEvent(event: TraceEvent, sequence: number, content: TraceEventContentPolicy): TraceEventLogEntry {
  const { activity: rawActivity, attributes: _attributes, payload: rawPayload, ...rest } = event
  const activity = normalizedTraceActivity(rawActivity)
  const payload = normalizedTracePayload(rawPayload)
  const attributes = traceEventAttributes({ activity, attributes: event.attributes, payload }, content)
  return {
    ...rest,
    ...(activity ? { activity } : {}),
    ...(attributes ? { attributes } : {}),
    ...(payload ? { payload } : {}),
    sequence,
    timestamp: timestamp(event.timestamp),
  }
}

export async function emitTraceEvent<TContext extends RuntimeHostContext<any>>(
  context: TContext,
  event: TraceEvent,
): Promise<TraceEventLogEntry | undefined> {
  return await context.traceLog?.append({
    ...event,
    trace: event.trace || context.trace,
  })
}

export function createTraceEventLog(options: TraceEventLogOptions = {}): TraceEventLog {
  const content = options.content || "metadata"
  const entries: TraceEventLogEntry[] = []
  const cloneAttributes = (attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!attributes) return undefined
    const cloned = { ...attributes }
    if ("vitehub.payload.value" in cloned) {
      cloned["vitehub.payload.value"] = structuredClone(cloned["vitehub.payload.value"])
    }
    return cloned
  }
  const cloneEntry = (entry: TraceEventLogEntry): TraceEventLogEntry => ({
    ...entry,
    ...(entry.activity ? { activity: structuredClone(entry.activity) } : {}),
    ...(entry.attributes ? { attributes: cloneAttributes(entry.attributes) } : {}),
    ...(entry.payload ? { payload: structuredClone(entry.payload) } : {}),
  })
  return {
    async append(event) {
      const entry = normalizeTraceEvent(event, entries.length + 1, content)
      entries.push(entry)
      await options.onEntry?.(cloneEntry(entry))
      return cloneEntry(entry)
    },
    entries() {
      return entries.map(cloneEntry)
    },
  }
}

function millis(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function durationMs(startTime: string, endTime: string | undefined): number | undefined {
  if (!endTime) return undefined
  const duration = millis(endTime) - millis(startTime)
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => hasRuntimeType(value, "string") && value.length > 0)
}

function runId(event: TraceEventLogEntry): string {
  return firstString(event.attributes?.["agent.run.id"], event.attributes?.["run.id"], event.attributes?.runId, event.trace?.id) || "default"
}

function stepId(event: TraceEventLogEntry): string | undefined {
  return firstString(
    event.attributes?.["step.id"],
    event.attributes?.["tool.id"],
    event.attributes?.["approval.id"],
    event.attributes?.["model.call.id"],
  )
}

function stepStatus(event: TraceEventLogEntry): TraceStepStatus {
  return event.type === "error" || /\.(?:cancelled|error|failed)$/.test(event.name)
    ? "failed"
    : /\.(?:output|progress|request|start|started|summary|updated)$/.test(event.name)
      ? "running"
      : "completed"
}

function isTraceRunFinish(event: TraceEventLogEntry): boolean {
  return event.name === "agent.invocation.finish" || event.name === "run.finish"
}

function isTraceRunError(event: TraceEventLogEntry): boolean {
  return event.name === "agent.invocation.error"
    || (event.name === "agent.stream.error" && event.attributes?.["error.recoverable"] !== true)
    || event.name === "run.error"
}

function isTraceRunTerminal(event: TraceEventLogEntry): boolean {
  return isTraceRunFinish(event) || isTraceRunError(event)
}

function isTraceRunFailureEvidence(event: TraceEventLogEntry): boolean {
  return event.name === "run.error"
    || (event.name === "agent.stream.error" && event.attributes?.["error.recoverable"] !== true)
}

export function deriveTraceRuns(events: Iterable<TraceEventLogEntry>): TraceRunView[] {
  const groups = new Map<string, TraceEventLogEntry[]>()
  for (const event of events) {
    const id = runId(event)
    groups.set(id, [...(groups.get(id) || []), event])
  }

  return [...groups.entries()].map(([id, group]) => {
    const sorted = group.slice().sort((a, b) => a.sequence - b.sequence)
    const first = sorted[0]!
    const steps = new Map<string, TraceStepView>()
    for (const event of sorted) {
      const id = stepId(event)
      if (!id) continue
      const existing = steps.get(id)
      const status = stepStatus(event)
      if (!existing) {
        steps.set(id, {
          attributes: stepTraceAttributes(event.attributes),
          endTime: status === "running" ? undefined : event.timestamp,
          events: [event],
          id,
          name: event.name.replace(/\.(start|started|progress|finish|completed|failed|cancelled|end|error|request|decision|recorded)$/, ""),
          startTime: event.timestamp,
          status,
          type: event.type,
        })
        continue
      }
      existing.events.push(event)
      const attributes = { ...existing.attributes }
      if (event.attributes?.["vitehub.payload.visibility"] !== undefined) {
        delete attributes["vitehub.payload.summary"]
        delete attributes["vitehub.payload.value"]
        delete attributes["vitehub.payload.visibility"]
      }
      existing.attributes = stepTraceAttributes({ ...attributes, ...event.attributes })
      if (status !== "running") {
        existing.endTime = event.timestamp
        existing.status = status
        existing.durationMs = durationMs(existing.startTime, existing.endTime)
      }
    }

    const terminal = sorted.slice().reverse().find(isTraceRunTerminal)
    const failed = sorted.some(isTraceRunFailureEvidence)
    const status: TraceRunStatus = failed || (terminal && isTraceRunError(terminal))
      ? "failed"
      : terminal
        ? "completed"
      : "running"
    const endTime = status === "running" ? undefined : terminal?.timestamp
    return {
      durationMs: durationMs(first.timestamp, endTime),
      endTime,
      events: sorted,
      id,
      startTime: first.timestamp,
      status,
      steps: [...steps.values()],
    }
  })
}

function traceRunTraceId(run: TraceRunView): string {
  return firstString(...run.events.map(event => event.trace?.id), run.id) || run.id
}

function traceRunParentId(run: TraceRunView): string | undefined {
  return firstString(...run.events.map(event => event.trace?.parentId))
}

function traceRunSpanId(run: TraceRunView): string {
  return firstString(...run.events.map(event => event.attributes?.["agent.invocation.id"]), run.id) || run.id
}

function isOpenTelemetryId(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value)
}

function openTelemetryId(value: string, length: 16 | 32): string {
  const normalized = value.toLowerCase()
  if (isOpenTelemetryId(normalized, length)) return normalized
  let output = ""
  for (let seed = 0; output.length < length; seed += 1) {
    let hash = 2166136261
    const input = `${value}:${seed}`
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    output += (hash >>> 0).toString(16).padStart(8, "0")
  }
  const id = output.slice(0, length)
  return /^0+$/.test(id) ? `1${id.slice(1)}` : id
}

export function traceEventsToOpenTelemetryLogRecords(events: Iterable<TraceEventLogEntry>, options: OpenTelemetrySpanViewOptions = {}): OpenTelemetryLogRecordView[] {
  const entries = [...events]
  return deriveTraceRuns(entries).flatMap((run) => {
    const spanId = openTelemetryId(traceRunSpanId(run), 16)
    const traceId = openTelemetryId(traceRunTraceId(run), 32)
    return run.events.map((event) => {
      const id = stepId(event)
      const attributes = traceEventAttributes(event, options.content === "metadata" ? "metadata" : "content")
      const error = event.type === "error" || /\.(?:cancelled|error|failed)$/.test(event.name)
      return {
        attributes: {
          ...attributes,
          "vitehub.event.sequence": event.sequence,
          "vitehub.event.type": event.type,
          "vitehub.run.id": run.id,
          ...(id ? { "vitehub.step.id": id } : {}),
        },
        eventName: event.name,
        ...(error ? { severityNumber: 17, severityText: "ERROR" } : {}),
        spanId: id ? openTelemetryId(`${spanId}:${id}`, 16) : spanId,
        time: event.timestamp,
        traceId,
      }
    })
  })
}

export function traceEventsToOpenTelemetrySpans(events: Iterable<TraceEventLogEntry>, options: OpenTelemetrySpanViewOptions = {}): OpenTelemetrySpanView[] {
  const maxEntries = 1024
  const firstEntries = maxEntries / 2
  const tailEntries = maxEntries / 2
  const entriesByRun = new Map<string, {
    count: number
    first: Array<{ entry: TraceEventLogEntry, index: number }>
    tail: Array<{ entry: TraceEventLogEntry, index: number } | undefined>
    failure?: { entry: TraceEventLogEntry, index: number }
    terminal?: { entry: TraceEventLogEntry, index: number }
  }>()
  for (const entry of events) {
    const id = runId(entry)
    let run = entriesByRun.get(id)
    if (!run) {
      run = { count: 0, first: [], tail: Array.from({ length: tailEntries }) }
      entriesByRun.set(id, run)
    }
    const indexed = { entry, index: run.count }
    if (run.count < firstEntries) run.first.push(indexed)
    else run.tail[(run.count - firstEntries) % tailEntries] = indexed
    if (isTraceRunFailureEvidence(entry)) run.failure = indexed
    if (isTraceRunTerminal(entry)) run.terminal = indexed
    run.count += 1
  }
  const boundedEntries = [...entriesByRun.values()].flatMap((run) => {
    const tail = run.tail.filter(entry => entry !== undefined).sort((left, right) => left.index - right.index)
    const evidence = [run.failure, run.terminal].filter(entry => entry !== undefined)
    const indexed = run.count <= maxEntries
      ? [...run.first, ...tail]
      : [...run.first, ...tail.slice(evidence.length), ...evidence]
    const entries = [...new Map(indexed.map(value => [value.index, value])).values()]
      .sort((left, right) => left.index - right.index)
      .map(value => value.entry)
    if (run.count <= maxEntries) return entries
    return entries.map((entry, index) => index === 0
      ? { ...entry, attributes: { ...entry.attributes, "vitehub.trace.originalEventCount": run.count, "vitehub.trace.truncated": true } }
      : entry)
  })
  const entries = boundedEntries.map(entry => ({
    ...entry,
    attributes: traceEventAttributes(entry, options.content === "metadata" ? "metadata" : "content"),
  }))
  return deriveTraceRuns(entries).flatMap((run) => {
    const rawParentSpanId = traceRunParentId(run)
    const rawTraceId = traceRunTraceId(run)
    const parentSpanId = rawParentSpanId ? openTelemetryId(rawParentSpanId, 16) : undefined
    const spanId = openTelemetryId(traceRunSpanId(run), 16)
    const traceId = openTelemetryId(rawTraceId, 32)
    const attributes = aggregateTraceAttributes(Object.assign({}, ...run.events.filter(event => !stepId(event)).map(event => event.attributes || {})))
    const spanEvents = (events: TraceEventLogEntry[]): OpenTelemetrySpanEventView[] => events.map(event => ({
      ...(event.attributes ? { attributes: event.attributes } : {}),
      name: event.name,
      time: event.timestamp,
    }))
    const errorMessage = firstString(...run.events.slice().reverse().map(event => event.attributes?.["error.message"]))
    return [
      {
        attributes: {
          ...attributes,
          "vitehub.run.id": run.id,
          ...(rawParentSpanId ? { "vitehub.trace.parentId": rawParentSpanId } : {}),
          "vitehub.trace.id": rawTraceId,
        },
        endTime: run.endTime,
        events: spanEvents(run.events.filter(event => !stepId(event))),
        name: "vitehub.run",
        ...(parentSpanId ? { parentSpanId } : {}),
        spanId,
        startTime: run.startTime,
        status: {
          code: run.status === "failed" ? "ERROR" : run.status === "completed" ? "OK" : "UNSET",
          ...(run.status === "failed" && errorMessage ? { message: errorMessage } : {}),
        },
        traceId,
      } satisfies OpenTelemetrySpanView,
      ...run.steps.map(step => ({
        attributes: {
          ...aggregateTraceAttributes(step.attributes),
          "vitehub.run.id": run.id,
          "vitehub.step.id": step.id,
        },
        endTime: step.endTime || run.endTime,
        events: spanEvents(step.events),
        name: step.name,
        parentSpanId: spanId,
        spanId: openTelemetryId(`${spanId}:${step.id}`, 16),
        startTime: step.startTime,
        // SAFETY: Runtime Capability normalization establishes the asserted host contract.
        status: {
          code: step.status === "failed" || (!step.endTime && run.status === "failed")
            ? "ERROR"
            : step.endTime || run.status === "completed"
              ? "OK"
              : "UNSET",
          ...(hasRuntimeType(step.attributes?.["error.message"], "string") ? { message: step.attributes["error.message"] } : {}),
        } as const,
        traceId,
      })),
    ]
  })
}

export interface Lease {
  expiresAt?: Date | string
  id: string
  key: string
  release(): MaybePromise<void>
}

export interface LeaseStore {
  acquire(key: string, options?: { owner?: string, ttl?: number }): MaybePromise<Lease>
}

type RuntimeConfigOf<TContext> = TContext extends { runtimeConfig?: infer TRuntimeConfig }
  ? Exclude<TRuntimeConfig, undefined>
  : Record<string, unknown>

export function createExecutionContext<TContext extends RuntimeHostContext<any>>(
  context: TContext,
): TContext & ExecutionContext<RuntimeConfigOf<TContext>> {
  return resolveExecutionContext(context)
}

export function resolveExecutionContext<TContext extends RuntimeHostContext<any>>(
  context: TContext,
): TContext & ExecutionContext<RuntimeConfigOf<TContext>> {
  return {
    ...context,
    capabilities: context.capabilities || {},
    // SAFETY: Runtime Capability normalization establishes the asserted host contract.
    runtimeConfig: (context.runtimeConfig || {}) as RuntimeConfigOf<TContext>,
  }
}

export function resolveRuntimeContext<TContext extends RuntimeHostContext<any>>(
  context: TContext,
): TContext & ExecutionContext<RuntimeConfigOf<TContext>> {
  return {
    ...context,
    // SAFETY: Runtime Capability normalization establishes the asserted host contract.
    runtimeConfig: (context.runtimeConfig || {}) as RuntimeConfigOf<TContext>,
  }
}

export function defineCapability<TKind extends string, TValue>(
  kind: TKind,
  value: TValue,
  options: { name?: string } = {},
): CapabilityHandle<TKind, TValue> {
  return {
    kind,
    name: options.name,
    value,
  }
}

export function createRuntimeWaitUntilController(options: {
  forward?: RuntimeWaitUntil
} = {}): RuntimeWaitUntilController {
  const pending: Promise<unknown>[] = []
  return {
    async flushWaitUntil() {
      while (pending.length > 0) {
        await Promise.all(pending.splice(0))
      }
    },
    waitUntil(task) {
      pending.push(task)
      options.forward?.(task)
    },
  }
}

function isCapabilityHandle(value: unknown): value is CapabilityHandle {
  return hasRuntimeType(value, "object")
    && value !== null
    && "kind" in value
    // SAFETY: Runtime Capability normalization establishes the asserted host contract.
    && hasRuntimeType((value as { kind?: unknown }).kind, "string")
    && "value" in value
}

export function hasCapability(context: RuntimeHostContext, name: string): boolean {
  return !!context.capabilities && name in context.capabilities
}

export function getCapability(
  context: RuntimeHostContext<any>,
  name: string,
): CapabilityHandle {
  const value = context.capabilities?.[name]
  if (value === undefined) {
    throw new ViteHubError("CAPABILITY_NOT_FOUND", `[vitehub:runtime] Capability "${name}" was not found.`, {
      details: { capability: name },
    })
  }
  if (isCapabilityHandle(value)) {
    return value
  }
  return defineCapability(name, value, { name })
}

export function isResolvable<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
): value is Resolvable<T, TContext> {
  return hasRuntimeType(value, "object")
    && value !== null
    && "resolve" in value
    // SAFETY: Runtime Capability normalization establishes the asserted host contract.
    && hasRuntimeType((value as { resolve?: unknown }).resolve, "function")
}

export async function resolveRuntimeValue<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  if (isResolvable(value)) {
    return await value.resolve(context)
  }

  if (hasRuntimeType(value, "function")) {
    // SAFETY: Runtime Capability normalization establishes the asserted host contract.
    return await (value as (context: TContext) => MaybePromise<T>)(context)
  }

  return value
}

export async function resolveCapabilityPolicy(
  policy: CapabilityPolicy | undefined,
  context: PolicyContext,
): Promise<PolicyDecision> {
  if (!policy) return "allow"
  return hasRuntimeType(policy, "function") ? await policy(context) : policy
}
