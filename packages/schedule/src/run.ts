import { createScheduleError } from "./errors.ts"
import { runScheduleErrors } from "./run-errors.ts"
import { parseScheduledAt } from "./runtime/date.ts"
import { executeManualSchedule, resolveManualSchedule } from "./runtime/execute.ts"

import type { Result } from "@vite-hub/runtime"
import type { RunScheduleErrorCode } from "./run-errors.ts"
import type { RunScheduleOptions } from "./runtime/execute.ts"
import type { ScheduleDefinitionRegistry, ScheduleRunRecord } from "./types.ts"

export type { RunScheduleErrorCode } from "./run-errors.ts"
export type { RunScheduleOptions } from "./runtime/execute.ts"

const registryModule = "#vitehub/schedule/registry"

async function loadRegistry(): Promise<ScheduleDefinitionRegistry> {
  try {
    return (await import(/* @vite-ignore */ /* @vitehub-schedule-registry */ registryModule) as { default: ScheduleDefinitionRegistry }).default
  }
  catch (cause) {
    throw createScheduleError("SCHEDULE_DEFINITION_NOT_FOUND", { cause })
  }
}

/**
 * Runs a Static Schedule Definition that sets `manual: true` now, as if its cron fired at `scheduledAt` (default: now).
 * It returns `[error, run]`. A failed handler is a run with `status: "failed"`, not an error. An invalid `scheduledAt`
 * or a failed run store is `error`. Definition loading errors, unknown names, and Definitions without `manual: true` throw.
 */
export async function runSchedule(name: string, options: RunScheduleOptions = {}): Promise<Result<ScheduleRunRecord, RunScheduleErrorCode>> {
  const registry = await loadRegistry()
  const definition = await resolveManualSchedule(registry, name)
  let scheduledAt: Date
  try {
    scheduledAt = parseScheduledAt(options.scheduledAt)
  }
  catch (cause) {
    return [runScheduleErrors.SCHEDULE_INVALID_SCHEDULED_AT({ cause }), undefined]
  }
  try {
    return [undefined, await executeManualSchedule(definition, name, scheduledAt)]
  }
  catch (cause) {
    return [runScheduleErrors.SCHEDULE_RUN_STORE_FAILED({ cause }), undefined]
  }
}
