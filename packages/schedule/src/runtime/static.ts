import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRegistryDefinition, ScheduleRunContext } from "../types.ts"
import { createLocalWaitUntil } from "./wait-until.ts"

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
}

export interface ExecuteCloudflareStaticSchedulesOptions {
  registry: ScheduleDefinitionRegistry
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

type LoadedScheduleModule = ScheduleRegistryDefinition | { default?: ScheduleRegistryDefinition }

export interface StaticScheduleRun extends ScheduleRunContext {
  cron: string
  scheduleId: string
}

export function createStaticScheduleRun(
  options: Omit<ExecuteStaticScheduleOptions, "definition" | "waitUntil"> & { waitUntil: NonNullable<ExecuteStaticScheduleOptions["waitUntil"]> },
): StaticScheduleRun {
  const scheduledAt = options.scheduledAt ?? new Date()
  return {
    cron: options.cron,
    id: `run_${options.name}_${scheduledAt.toISOString()}`,
    scheduleId: options.name,
    scheduledAt,
    waitUntil: options.waitUntil,
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<unknown> {
  const localWaitUntil = createLocalWaitUntil()
  try {
    const result = await options.definition.handler(createStaticScheduleRun({
      ...options,
      waitUntil: options.waitUntil ?? localWaitUntil.waitUntil,
    }))
    if (!options.waitUntil) await localWaitUntil.flush()
    return result
  }
  catch (error) {
    if (!options.waitUntil) {
      try {
        await localWaitUntil.flush()
      }
      catch {
        // Preserve the handler error after all locally owned work settles.
      }
    }
    throw error
  }
}

export async function executeMatchingStaticSchedules(options: ExecuteMatchingStaticSchedulesOptions): Promise<unknown[]> {
  const scheduledAt = options.scheduledAt ?? new Date()
  const runs: Array<Promise<unknown>> = []
  for (const [name, load] of Object.entries(options.registry)) {
    const definition = unwrapScheduleDefinition(await load())
    if (!definition || definition.cron !== options.cron) continue
    runs.push(executeStaticSchedule({ cron: options.cron, definition, name, scheduledAt }))
  }
  return await Promise.all(runs)
}

export async function executeCloudflareStaticSchedules(
  event: CloudflareScheduledEventLike,
  options: ExecuteCloudflareStaticSchedulesOptions,
): Promise<unknown[]> {
  const scheduled = readCloudflareScheduledEvent(event)
  return await runWithCloudflareServerEnv(event, async () => {
    return await executeMatchingStaticSchedules({
      cron: scheduled.cron,
      registry: options.registry,
      scheduledAt: scheduled.scheduledAt,
    })
  })
}

function readCloudflareScheduledEvent(event: CloudflareScheduledEventLike): { cron: string, scheduledAt: Date } {
  const cron = event.controller?.cron ?? event.cron
  if (!cron) {
    throw new TypeError("[vitehub:schedule] Cloudflare scheduled event is missing a cron string.")
  }
  const scheduledTime = event.controller?.scheduledTime ?? event.scheduledTime
  const scheduledAt = scheduledTime instanceof Date
    ? scheduledTime
    : typeof scheduledTime === "number" || typeof scheduledTime === "string"
      ? new Date(scheduledTime)
      : new Date()
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new TypeError("[vitehub:schedule] Cloudflare scheduled event has an invalid scheduledTime.")
  }
  return { cron, scheduledAt }
}

function runWithCloudflareServerEnv<T>(event: CloudflareScheduledEventLike, callback: () => T): T {
  const globals = globalThis as { __env__?: Record<string, unknown> }
  const hadGlobalEnv = Object.prototype.hasOwnProperty.call(globals, "__env__")
  const previousGlobalEnv = globals.__env__
  const env = readCloudflareEventEnv(event)
  if (env) globals.__env__ = env

  try {
    const result = callback()
    if (isPromiseLike(result)) {
      return result.finally(() => restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)) as T
    }
    restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
    return result
  }
  catch (error) {
    restoreGlobalEnv(globals, hadGlobalEnv, previousGlobalEnv)
    throw error
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

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { finally?: unknown }).finally === "function"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function unwrapScheduleDefinition(loaded: LoadedScheduleModule): ScheduleDefinition | undefined {
  const definition = typeof loaded === "object" && loaded !== null && "default" in loaded ? loaded.default : loaded
  return definition && "cron" in definition ? definition : undefined
}
