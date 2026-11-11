import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunContext } from "../types.ts"
import { runWithScheduleWaitUntil } from "./wait-until.ts"
import { createScheduleError, invalidScheduleValueDetails } from "../errors.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { isScheduleDate, scheduleIdempotencyKey, validateScheduledAt } from "./date.ts"
import { isScheduleDue, latestCronMinute } from "./due.ts"

export interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface ExecuteMatchingStaticSchedulesOptions {
  cron: string
  /** Cron per Schedule name that the host registered in place of the Definition's cron. */
  cronOverrides?: Readonly<Record<string, string>>
  registry: ScheduleDefinitionRegistry
  scheduledAt?: Date
  /**
   * UTC cron that the host registered for each Schedule with a `timeZone`. A wake runs such a Schedule only when its
   * own cron is due in its time zone at that minute. `cronOverrides` wins over this map.
   */
  timeZoneCrons?: Readonly<Record<string, string>>
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface ExecuteCloudflareStaticSchedulesOptions {
  /** Cron per Schedule name that the host registered in place of the Definition's cron. */
  cronOverrides?: Readonly<Record<string, string>>
  registry: ScheduleDefinitionRegistry
  /** UTC cron that the host registered for each Schedule with a `timeZone`. */
  timeZoneCrons?: Readonly<Record<string, string>>
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface CloudflareScheduledEventLike {
  [key: string]: unknown
  controller?: {
    cron?: string
    scheduledTime?: number | string | Date
  }
  cron?: string
  scheduledTime?: number | string | Date
}

const intrinsicErrorIsError = (Error as ErrorConstructor & { isError?: (value: unknown) => boolean }).isError
const intrinsicNativeErrorIsError = (() => {
  try {
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- Node's optional process bridge is inspected at runtime to avoid importing Node-only modules in provider bundles.
    const process = (globalThis as typeof globalThis & {
      process?: { getBuiltinModule?: (name: string) => unknown }
    }).process
    const getBuiltinModule = process?.getBuiltinModule
    if (typeof getBuiltinModule !== "function") return undefined
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- getBuiltinModule returns an unknown namespace that is narrowed by the guarded predicate below.
    const util = getBuiltinModule.call(process, "util") as {
      types?: { isNativeError?: (value: unknown) => boolean }
    } | undefined
    return typeof util?.types?.isNativeError === "function" ? util.types.isNativeError : undefined
  }
  catch {
    return undefined
  }
})()

export interface StaticScheduleRun extends ScheduleRunContext {
  cron: string
  scheduleId: string
}

export function missingScheduleDefinitionError(name: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_R0034({ message: `Missing schedule definition: ${name}` })
}

/**
 * Checks the `Authorization` header of a Vercel Cron request against `CRON_SECRET` in constant time.
 */
export function isScheduleCronAuthorized(authorization: string | null | undefined, cronSecret: string): boolean {
  return isViteHubBearerSecretEqual(authorization, cronSecret)
}

export function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ")
}

export function normalizeScheduleRuntimeError(error: unknown): Error {
  if (isScheduleRuntimeError(error)) return error
  let message: string | undefined
  try {
    message = String(error)
  }
  catch {
    message = "[unprintable thrown value]"
  }
  try {
    return scheduleErrorDiagnostics.SCHEDULE_R0035({ cause: error, message })
  }
  catch {
    const fallback = new Error(message)
    Object.defineProperty(fallback, "code", { value: "SCHEDULE_R0035", enumerable: true })
    Object.defineProperty(fallback, "cause", { value: error })
    return fallback
  }
}

function isScheduleRuntimeError(error: unknown): error is Error {
  try {
    if (error instanceof Error) return true
  }
  catch {
    return false
  }
  if (error === null || typeof error !== "object") return false
  if (typeof intrinsicNativeErrorIsError === "function") {
    try {
      return intrinsicNativeErrorIsError(error)
    }
    catch {
      // Continue with the captured Error.isError predicate when the host utility rejects the value.
    }
  }
  try {
    return typeof intrinsicErrorIsError === "function" && intrinsicErrorIsError(error) === true
  }
  catch {
    return false
  }
}

/**
 * Estimates a wake minute from callback time when the host supplies no scheduled timestamp. This is the newest UTC
 * cron match within one day, or the current minute when none matches. It cannot identify a delayed or retried wake
 * after another cron match; callers must not treat it as the provider's occurrence identity.
 */
export function scheduledWakeTime(cron: string, now: Date = new Date()): Date {
  return latestCronMinute(normalizeCron(cron), now)
}

/**
 * Returns `true` when a host wake at `scheduledAt` is an occurrence of the Definition's cron in its `timeZone`. The host
 * runs a wider UTC cron for a time-zoned Schedule, so the runtime skips the wakes that are not local occurrences.
 */
export function isTimeZoneWakeDue(definition: ScheduleDefinition & { cron: string }, name: string, scheduledAt: Date): boolean {
  const minute = new Date(Math.floor(scheduledAt.getTime() / 60_000) * 60_000)
  return isScheduleDue({ cron: definition.cron, id: name, ...(definition.timeZone ? { timeZone: definition.timeZone } : {}) }, minute)
}

export function createStaticScheduleRun(
  options: Omit<ExecuteStaticScheduleOptions, "definition" | "waitUntil"> & { waitUntil: NonNullable<ExecuteStaticScheduleOptions["waitUntil"]> },
): StaticScheduleRun {
  const scheduledAt = validateScheduledAt(options.scheduledAt)
  return {
    cron: options.cron,
    id: `run_${options.name}_${scheduledAt.toISOString()}`,
    idempotencyKey: scheduleIdempotencyKey(options.name, scheduledAt),
    scheduleId: options.name,
    scheduledAt,
    waitUntil: options.waitUntil,
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<unknown> {
  return await runWithScheduleWaitUntil(
    waitUntil => options.definition.handler(createStaticScheduleRun({ ...options, waitUntil })),
    options.waitUntil,
  )
}

export async function executeMatchingStaticSchedules(options: ExecuteMatchingStaticSchedulesOptions): Promise<unknown[]> {
  if (typeof options.cron !== "string" || !options.cron.trim()) {
    throw createScheduleError("SCHEDULE_INVALID_CRON", {
      details: invalidScheduleValueDetails("cron", options.cron),
    })
  }
  const cron = normalizeCron(options.cron)
  const scheduledAt = validateScheduledAt(options.scheduledAt)
  const runs: Array<{ name: string, run: Promise<unknown> }> = []
  for (const [name, load] of Object.entries(options.registry)) {
    const definition = unwrapScheduleDefinition(await load())
    if (!definition) continue
    const override = options.cronOverrides && Object.hasOwn(options.cronOverrides, name) ? options.cronOverrides[name] : undefined
    const timeZoneCron = override === undefined && options.timeZoneCrons && Object.hasOwn(options.timeZoneCrons, name) ? options.timeZoneCrons[name] : undefined
    if (normalizeCron(override ?? timeZoneCron ?? definition.cron) !== cron) continue
    if (timeZoneCron !== undefined && !isTimeZoneWakeDue(definition, name, scheduledAt)) continue
    runs.push({ name, run: executeStaticSchedule({ cron: options.cron, definition, name, scheduledAt, waitUntil: options.waitUntil }) })
  }
  // One failed schedule must not hide the result of the others. Hosts log only the rejection, without its cause.
  const results = await Promise.allSettled(runs.map(({ run }) => run))
  const failures: unknown[] = []
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return
    failures.push(result.reason)
    console.error(`[vitehub:schedule] Schedule "${runs[index]!.name}" failed (cron "${options.cron}").`, normalizeRuntimeDiagnosticError(result.reason, { includeStack: true }))
  })
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, `[vitehub:schedule] ${failures.length} schedules failed for cron "${options.cron}".`)
  return results.map(result => result.status === "fulfilled" ? result.value : undefined)
}

export async function executeCloudflareStaticSchedules(
  event: CloudflareScheduledEventLike,
  options: ExecuteCloudflareStaticSchedulesOptions,
): Promise<unknown[]> {
  const scheduled = readCloudflareScheduledEvent(event)
  const hostWaitUntil = options.waitUntil ?? readCloudflareWaitUntil(event)
  return await runWithCloudflareServerEnv(event, async (waitUntil) => {
    return await executeMatchingStaticSchedules({
      cron: scheduled.cron,
      cronOverrides: options.cronOverrides,
      registry: options.registry,
      scheduledAt: scheduled.scheduledAt,
      timeZoneCrons: options.timeZoneCrons,
      waitUntil,
    })
  }, hostWaitUntil)
}

function readCloudflareScheduledEvent(event: CloudflareScheduledEventLike): { cron: string, scheduledAt: Date } {
  const cron = event.controller?.cron ?? event.cron
  if (typeof cron !== "string" || !cron.trim()) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0027({ message: "[vitehub:schedule] Cloudflare scheduled event is missing a cron string." })
  }
  const scheduledTime = event.controller?.scheduledTime ?? event.scheduledTime
  const scheduledAt = isScheduleDate(scheduledTime)
    ? new Date(Date.prototype.getTime.call(scheduledTime))
    : scheduledTime === undefined
      ? new Date()
      : new Date(scheduledTime)
  if (Number.isNaN(scheduledAt.getTime())) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0028({ message: "[vitehub:schedule] Cloudflare scheduled event has an invalid scheduledTime." })
  }
  return { cron, scheduledAt }
}

async function runWithCloudflareServerEnv<T>(
  event: CloudflareScheduledEventLike,
  callback: (waitUntil?: (promise: PromiseLike<unknown>) => void) => Promise<T>,
  hostWaitUntil?: (promise: Promise<unknown>) => void,
): Promise<T> {
  // SAFETY: Static Cloudflare execution owns the conventional global __env__ bridge for this callback.
  const globals = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }
  const hadGlobalEnv = Object.prototype.hasOwnProperty.call(globals, "__env__")
  const previousGlobalEnv = globals.__env__
  const env = readCloudflareEventEnv(event)
  if (env) globals.__env__ = env
  const pending = new Set<Promise<unknown>>()
  const waitUntil = hostWaitUntil
    ? (value: PromiseLike<unknown>) => {
        const promise = Promise.resolve(value)
        pending.add(promise)
        void promise.then(
          () => pending.delete(promise),
          () => pending.delete(promise),
        )
        hostWaitUntil(promise)
      }
    : undefined

  try {
    return await callback(waitUntil)
  }
  finally {
    if (pending.size === 0) {
      restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
    }
    else {
      hostWaitUntil!(flushPendingWork(pending).finally(() => {
        restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
      }))
    }
  }
}

async function flushPendingWork(pending: Set<Promise<unknown>>): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled(pending)
  }
}

function restoreGlobalEnv(
  globals: { __env__?: Record<string, unknown> },
  hadGlobalEnv: boolean,
  previousGlobalEnv: Record<string, unknown> | undefined,
): void {
  if (hadGlobalEnv) globals.__env__ = previousGlobalEnv
  else delete globals.__env__
}

function isCallable(value: unknown): value is CallableFunction {
  // Callable HTMLDDA browser values report undefined without being undefined.
  return typeof value === "function" || (typeof value === "undefined" && value !== undefined)
}

// ponytail: Keep this provider entry free of the Node-backed shared Cloudflare runtime module.
function readCloudflareWaitUntil(event: CloudflareScheduledEventLike): ((promise: Promise<unknown>) => void) | undefined {
  const context = isRecord(event.context) ? event.context : undefined
  const cloudflareContext = isRecord(context?.cloudflare) ? context.cloudflare : undefined
  const platformContext = isRecord(context?._platform) ? context._platform : undefined
  const platformCloudflareContext = isRecord(platformContext?.cloudflare) ? platformContext.cloudflare : undefined
  const request = isRecord(event.req) ? event.req : undefined
  const runtime = isRecord(request?.runtime) ? request.runtime : undefined
  const runtimeCloudflare = isRecord(runtime?.cloudflare) ? runtime.cloudflare : undefined
  const owners = [
    event,
    context,
    cloudflareContext,
    isRecord(cloudflareContext?.context) ? cloudflareContext.context : undefined,
    platformCloudflareContext,
    isRecord(platformCloudflareContext?.context) ? platformCloudflareContext.context : undefined,
    request,
    runtimeCloudflare,
    isRecord(runtimeCloudflare?.context) ? runtimeCloudflare.context : undefined,
  ]
  for (const owner of owners) {
    const waitUntil = owner?.waitUntil
    if (isCallable(waitUntil)) {
      return promise => Reflect.apply(waitUntil, owner, [promise])
    }
  }
}

function readCloudflareEventEnv(event: CloudflareScheduledEventLike): Record<string, unknown> | undefined {
  if (isRecord(event.env)) return event.env
  const context = isRecord(event.context) ? event.context : undefined
  const cloudflareContext = isRecord(context?.cloudflare) ? context.cloudflare : undefined
  if (isRecord(cloudflareContext?.env)) return cloudflareContext.env
  const platformContext = isRecord(context?._platform) ? context._platform : undefined
  const platformCloudflareContext = isRecord(platformContext?.cloudflare) ? platformContext.cloudflare : undefined
  if (isRecord(platformCloudflareContext?.env)) return platformCloudflareContext.env
  const request = isRecord(event.req) ? event.req : undefined
  const runtime = isRecord(request?.runtime) ? request.runtime : undefined
  const runtimeCloudflare = isRecord(runtime?.cloudflare) ? runtime.cloudflare : undefined
  return isRecord(runtimeCloudflare?.env) ? runtimeCloudflare.env : undefined
}

function isStaticScheduleDefinition(value: unknown): value is ScheduleDefinition & { cron: string } {
  return isRecord(value)
    && Object.hasOwn(value, "cron")
    && typeof value.cron === "string"
    && Object.hasOwn(value, "handler")
    && typeof value.handler === "function"
}

export function unwrapScheduleDefinition(loaded: unknown): (ScheduleDefinition & { cron: string }) | undefined {
  const candidate = isRecord(loaded) && Object.hasOwn(loaded, "default") ? loaded.default : loaded
  return isStaticScheduleDefinition(candidate) ? candidate : undefined
}
