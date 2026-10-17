import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunContext, ScheduleRunRecord } from "../types.ts"
import { runWithScheduleWaitUntil } from "./wait-until.ts"
import { executeStaticSchedule as executeRecordedStaticSchedule } from "./execute.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { isViteHubBearerSecretEqual } from "@vite-hub/internal/secret"
import { validateScheduledAt } from "./date.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

export interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface StaticScheduleRun extends ScheduleRunContext {
  cron: string
  scheduleId: string
}

/** The event that Nitro passes to a task `run()` function. */
export interface ScheduleTaskEvent {
  context?: Record<string, unknown>
  name: string
  payload?: Record<string, unknown>
}

const scheduleTaskPrefix = "vitehub:schedule:"

/** The Nitro task name of a Static Schedule Definition. */
export function getScheduleTaskName(name: string): string {
  return `${scheduleTaskPrefix}${name}`
}

export function missingScheduleDefinitionError(name: string): Error {
  return scheduleErrorDiagnostics.SCHEDULE_R0034({ message: `Missing schedule definition: ${name}` })
}

/**
 * Checks a `Bearer` authorization header against the schedule secret in constant time.
 */
export function isScheduleCronAuthorized(authorization: string | null | undefined, cronSecret: string): boolean {
  return isViteHubBearerSecretEqual(authorization, cronSecret)
}

export function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ")
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

function readTaskWaitUntil(context: Record<string, unknown> | undefined): ((promise: PromiseLike<unknown>) => void) | undefined {
  const cloudflare = isObjectRecord(context?.cloudflare) ? context.cloudflare : undefined
  const cloudflareContext = isObjectRecord(cloudflare?.context) ? cloudflare.context : undefined
  for (const owner of [context, cloudflareContext]) {
    const waitUntil = owner?.waitUntil
    if (hasRuntimeType(waitUntil, "function")) return promise => Reflect.apply(waitUntil, owner, [promise])
  }
}

/**
 * Runs one Static Schedule Definition from a Nitro task. Nitro fires the task on the
 * Definition cron. The run uses the current UTC minute as its scheduled time.
 */
export async function runScheduleTask(event: ScheduleTaskEvent, registry: ScheduleDefinitionRegistry): Promise<{ result: ScheduleRunRecord }> {
  const name = event.name.startsWith(scheduleTaskPrefix) ? event.name.slice(scheduleTaskPrefix.length) : event.name
  const load = Object.hasOwn(registry, name) ? registry[name] : undefined
  const definition = load ? unwrapScheduleDefinition(await load()) : undefined
  if (!definition) throw missingScheduleDefinitionError(name)
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  return {
    result: await executeRecordedStaticSchedule({
      cron: definition.cron,
      definition,
      name,
      scheduledAt: new Date(minute),
      waitUntil: readTaskWaitUntil(event.context),
    }),
  }
}

function isStaticScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return isObjectRecord(value)
    && Object.hasOwn(value, "cron")
    && hasRuntimeType(value.cron, "string")
    && Object.hasOwn(value, "handler")
    && hasRuntimeType(value.handler, "function")
}

export function unwrapScheduleDefinition(loaded: unknown): ScheduleDefinition | undefined {
  const candidate = isObjectRecord(loaded) && Object.hasOwn(loaded, "default") ? loaded.default : loaded
  return isStaticScheduleDefinition(candidate) ? candidate : undefined
}
