import { ViteHubError } from "./errors.ts"

export {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const authority = value as Record<string, unknown>
  const filesystem = authority.filesystem
  if (!filesystem || typeof filesystem !== "object" || Array.isArray(filesystem)) return false
  const files = filesystem as Record<string, unknown>
  return typeof authority.credentials === "string"
    && ["ambient", "none", "provisioned", "unknown"].includes(authority.credentials)
    && typeof authority.environment === "string"
    && ["ambient", "none", "selected", "unknown"].includes(authority.environment)
    && typeof files.access === "string"
    && ["none", "read-only", "read-write", "unknown"].includes(files.access)
    && typeof files.scope === "string"
    && ["host", "none", "sandbox", "unknown", "workspace"].includes(files.scope)
    && typeof authority.isolation === "string"
    && ["container", "microvm", "none", "process", "unknown"].includes(authority.isolation)
    && typeof authority.network === "string"
    && ["none", "restricted", "unrestricted", "unknown"].includes(authority.network)
    && typeof authority.processes === "string"
    && ["arbitrary", "none", "restricted", "unknown"].includes(authority.processes)
}

export function normalizeExecutionAuthority(value: unknown): ExecutionAuthority {
  if (!isExecutionAuthority(value)) {
    throw new TypeError("[vitehub] Invalid execution authority descriptor.")
  }
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

export type TraceEventContentPolicy = "content" | "metadata"
export type TraceRunStatus = "completed" | "failed" | "running"
export type TraceStepStatus = "completed" | "failed" | "running"

export interface TraceEvent {
  attributes?: Record<string, unknown>
  name: string
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
  name: string
  parentSpanId?: string
  spanId: string
  startTime: string
  status: { code: "ERROR" | "OK", message?: string }
  traceId: string
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
  "prompt",
  "raw",
  "request",
  "response",
  "result",
  "text",
])

function isContentAttributeKey(key: string): boolean {
  if (key === "error.message") return false
  if (contentAttributeKeys.has(key)) return true
  return key.split(".").some((part, index) => index > 0 && contentAttributeKeys.has(part))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
}

function metadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(metadataValue)
  if (!isPlainRecord(value)) return value
  const omitted: string[] = []
  const next = Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (isContentAttributeKey(key)) {
      omitted.push(key)
      return []
    }
    return [[key, metadataValue(child)]]
  }))
  if (omitted.length) next["content.omitted"] = omitted
  return next
}

function timestamp(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  return new Date().toISOString()
}

function metadataAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attributes) return undefined
  const omitted: string[] = []
  const next = Object.fromEntries(Object.entries(attributes).flatMap(([key, value]) => {
    if (isContentAttributeKey(key)) {
      omitted.push(key)
      return []
    }
    return [[key, metadataValue(value)]]
  }))
  if (omitted.length) next["content.omitted"] = omitted
  return Object.keys(next).length ? next : undefined
}

function normalizeTraceEvent(event: TraceEvent, sequence: number, content: TraceEventContentPolicy): TraceEventLogEntry {
  return {
    ...event,
    ...(content === "metadata" ? { attributes: metadataAttributes(event.attributes) } : {}),
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
  return {
    async append(event) {
      const entry = normalizeTraceEvent(event, entries.length + 1, content)
      entries.push(entry)
      await options.onEntry?.(entry)
      return entry
    },
    entries() {
      return entries.slice()
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
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
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
  return event.type === "error" || event.name.endsWith(".error") ? "failed" : event.name.endsWith(".start") || event.name.endsWith(".request") ? "running" : "completed"
}

function isTraceRunFinish(event: TraceEventLogEntry): boolean {
  return event.name === "agent.invocation.finish" || event.name === "run.finish"
}

function isTraceRunError(event: TraceEventLogEntry): boolean {
  return event.name === "agent.invocation.error" || event.name === "agent.stream.error" || event.name === "run.error"
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
          attributes: event.attributes,
          endTime: status === "running" ? undefined : event.timestamp,
          events: [event],
          id,
          name: event.name.replace(/\.(start|finish|end|error|request|decision|recorded)$/, ""),
          startTime: event.timestamp,
          status,
          type: event.type,
        })
        continue
      }
      existing.events.push(event)
      existing.attributes = { ...existing.attributes, ...event.attributes }
      if (status !== "running") {
        existing.endTime = event.timestamp
        existing.status = status
        existing.durationMs = durationMs(existing.startTime, existing.endTime)
      }
    }

    const terminal = sorted.slice().reverse().find(event => isTraceRunError(event) || isTraceRunFinish(event))
    const status: TraceRunStatus = sorted.some(isTraceRunError)
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

export function traceEventsToOpenTelemetrySpans(events: Iterable<TraceEventLogEntry>): OpenTelemetrySpanView[] {
  return deriveTraceRuns(events).flatMap((run) => {
    const rawParentSpanId = traceRunParentId(run)
    const rawTraceId = traceRunTraceId(run)
    const parentSpanId = rawParentSpanId ? openTelemetryId(rawParentSpanId, 16) : undefined
    const spanId = openTelemetryId(run.id, 16)
    const traceId = openTelemetryId(rawTraceId, 32)
    return [
      {
        attributes: {
          "vitehub.run.id": run.id,
          ...(rawParentSpanId ? { "vitehub.trace.parentId": rawParentSpanId } : {}),
          "vitehub.trace.id": rawTraceId,
        },
        endTime: run.endTime,
        name: "vitehub.run",
        ...(parentSpanId ? { parentSpanId } : {}),
        spanId,
        startTime: run.startTime,
        status: { code: run.status === "failed" ? "ERROR" : "OK" },
        traceId,
      } satisfies OpenTelemetrySpanView,
      ...run.steps.map(step => ({
        attributes: {
          ...step.attributes,
          "vitehub.run.id": run.id,
          "vitehub.step.id": step.id,
        },
        endTime: step.endTime,
        name: step.name,
        parentSpanId: spanId,
        spanId: openTelemetryId(`${run.id}:${step.id}`, 16),
        startTime: step.startTime,
        status: { code: step.status === "failed" ? "ERROR" : "OK" } as const,
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

export class CapabilityNotFoundError extends ViteHubError<"CAPABILITY_NOT_FOUND", { capability: string }> {
  constructor(name: string) {
    super("CAPABILITY_NOT_FOUND", `[vitehub:runtime] Capability "${name}" was not found.`, {
      details: { capability: name },
      retryable: false,
    })
    this.name = "CapabilityNotFoundError"
  }
}

export interface CapabilityDeniedErrorOptions extends ErrorOptions {
  safeReason?: string
}

export class CapabilityDeniedError extends ViteHubError<"CAPABILITY_DENIED", { capability: string, reason?: string }> {
  constructor(name: string, options: CapabilityDeniedErrorOptions = {}) {
    const reason = options.safeReason
    super("CAPABILITY_DENIED", `[vitehub:runtime] Capability "${name}" was denied${reason ? `: ${reason}` : "."}`, {
      cause: options.cause,
      details: { capability: name, ...(reason === undefined ? {} : { reason }) },
      retryable: false,
    })
    this.name = "CapabilityDeniedError"
  }
}

export class ApprovalRequiredError<TInput = unknown> extends ViteHubError<"APPROVAL_REQUIRED", { capability: string, requestId: string }> {
  request: ApprovalRequest<TInput>

  constructor(request: ApprovalRequest<TInput>) {
    const capability = request.capability || request.id
    super("APPROVAL_REQUIRED", `[vitehub:runtime] Approval is required for "${capability}".`, {
      details: { capability, requestId: request.id },
      requestId: request.id,
      retryable: false,
    })
    this.name = "ApprovalRequiredError"
    this.request = request
  }
}

export function createExecutionContext<
  TRuntimeConfig = Record<string, unknown>,
  TContext extends RuntimeHostContext<TRuntimeConfig> = RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return resolveExecutionContext(context)
}

export function resolveExecutionContext<
  TRuntimeConfig = Record<string, unknown>,
  TContext extends RuntimeHostContext<TRuntimeConfig> = RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return {
    ...context,
    capabilities: context.capabilities || {},
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
  }
}

export function resolveRuntimeContext<
  TRuntimeConfig = Record<string, unknown>,
  TContext extends RuntimeHostContext<TRuntimeConfig> = RuntimeHostContext<TRuntimeConfig>,
>(
  context: TContext,
): TContext & ExecutionContext<TRuntimeConfig> {
  return {
    ...context,
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
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
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && typeof (value as { kind?: unknown }).kind === "string"
    && "value" in value
}

export function hasCapability(context: RuntimeHostContext, name: string): boolean {
  return !!context.capabilities && name in context.capabilities
}

export function getCapability<TKind extends string = string, TValue = unknown>(
  context: RuntimeHostContext,
  name: string,
): CapabilityHandle<TKind, TValue> {
  const value = context.capabilities?.[name]
  if (value === undefined) {
    throw new CapabilityNotFoundError(name)
  }
  if (isCapabilityHandle(value)) {
    return value as CapabilityHandle<TKind, TValue>
  }
  return defineCapability(name as TKind, value as TValue, { name })
}

export function isResolvable<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
): value is Resolvable<T, TContext> {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

export async function resolveRuntimeValue<T, TContext extends RuntimeHostContext<any>>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  if (isResolvable(value)) {
    return await value.resolve(context)
  }

  if (typeof value === "function") {
    return await (value as (context: TContext) => MaybePromise<T>)(context)
  }

  return value
}

export async function resolveCapabilityPolicy(
  policy: CapabilityPolicy | undefined,
  context: PolicyContext,
): Promise<PolicyDecision> {
  if (!policy) return "allow"
  return typeof policy === "function" ? await policy(context) : policy
}
