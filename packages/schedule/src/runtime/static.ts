import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunContext } from "../types.ts"
import { runWithScheduleWaitUntil } from "./wait-until.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { createScheduleError, invalidScheduleValueDetails } from "../errors.ts"
import { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

export interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface ExecuteMatchingStaticSchedulesOptions {
  cron: string
  registry: ScheduleDefinitionRegistry
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface ExecuteCloudflareStaticSchedulesOptions {
  registry: ScheduleDefinitionRegistry
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
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The optional Node API must be validated before invocation.
    if (typeof getBuiltinModule !== "function") return undefined
    // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- getBuiltinModule returns an unknown namespace that is narrowed by the guarded predicate below.
    const util = getBuiltinModule.call(process, "util") as {
      types?: { isNativeError?: (value: unknown) => boolean }
    } | undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The optional Node API must be validated before capture.
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The optional intrinsic predicate is captured from the host at module load.
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

export function createStaticScheduleRun(
  options: Omit<ExecuteStaticScheduleOptions, "definition" | "waitUntil"> & { waitUntil: NonNullable<ExecuteStaticScheduleOptions["waitUntil"]> },
): StaticScheduleRun {
  const scheduledAt = validateScheduledAt(options.scheduledAt)
  return {
    cron: options.cron,
    id: `run_${options.name}_${scheduledAt.toISOString()}`,
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
  if (!hasRuntimeType(options.cron, "string") || !options.cron.trim()) {
    throw createScheduleError("SCHEDULE_INVALID_CRON", {
      details: invalidScheduleValueDetails("cron", options.cron),
    })
  }
  const cron = normalizeCron(options.cron)
  const scheduledAt = validateScheduledAt(options.scheduledAt)
  const runs: Array<Promise<unknown>> = []
  for (const [name, load] of Object.entries(options.registry)) {
    const definition = unwrapScheduleDefinition(await load())
    if (!definition || normalizeCron(definition.cron) !== cron) continue
    runs.push(executeStaticSchedule({ cron: options.cron, definition, name, scheduledAt, waitUntil: options.waitUntil }))
  }
  return await Promise.all(runs)
}

function validateScheduledAt(scheduledAt: Date | undefined): Date {
  const value = scheduledAt ?? new Date()
  let time: number
  try {
    time = Date.prototype.getTime.call(value)
  }
  catch {
    throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", {
      details: invalidScheduleValueDetails("scheduledAt", value),
    })
  }
  if (Number.isNaN(time)) {
    throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", {
      details: invalidScheduleValueDetails("scheduledAt", value),
    })
  }
  return new Date(time)
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
      registry: options.registry,
      scheduledAt: scheduled.scheduledAt,
      waitUntil,
    })
  }, hostWaitUntil)
}

function readCloudflareScheduledEvent(event: CloudflareScheduledEventLike): { cron: string, scheduledAt: Date } {
  const cron = event.controller?.cron ?? event.cron
  if (!hasRuntimeType(cron, "string") || !cron.trim()) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0027({ message: "[vitehub:schedule] Cloudflare scheduled event is missing a cron string." })
  }
  const scheduledTime = event.controller?.scheduledTime ?? event.scheduledTime
  let scheduledAt: Date
  try {
    if (scheduledTime === undefined) {
      scheduledAt = new Date()
    }
    else {
      try {
        scheduledAt = new Date(Date.prototype.getTime.call(scheduledTime))
      }
      catch {
        scheduledAt = new Date(scheduledTime)
      }
    }
    if (Number.isNaN(Date.prototype.getTime.call(scheduledAt))) throw new Error("invalid date")
  }
  catch {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

function isCallable(value: unknown): value is CallableFunction {
  if (value === null || value === undefined || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  }
  catch {
    return false
  }
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

function isStaticScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return isObjectRecord(value)
    && Object.hasOwn(value, "cron")
    && hasRuntimeType(value.cron, "string")
    && Object.hasOwn(value, "handler")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry handlers cross module and JavaScript realm boundaries; validate callability without realm-sensitive instanceof.
    && typeof value.handler === "function"
}

export function unwrapScheduleDefinition(loaded: unknown): ScheduleDefinition | undefined {
  const candidate = isObjectRecord(loaded) && Object.hasOwn(loaded, "default") ? loaded.default : loaded
  return isStaticScheduleDefinition(candidate) ? candidate : undefined
}
