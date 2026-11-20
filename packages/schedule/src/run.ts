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

// The Schedule Vite plugin turns the marked import below into `import("#vitehub/schedule/registry")`. Without the
// plugin, a bundler keeps the variable import as it is, so a build without Schedule still succeeds.
const registryModule = "#vitehub/schedule/registry"

/** Imports the registry that the Schedule Vite plugin generates. It loads on the first call, so importing the root stays cheap. */
export async function importScheduleRegistry(): Promise<ScheduleDefinitionRegistry> {
  return (await import(/* @vite-ignore */ /* @vitehub-schedule-registry */ registryModule) as { default: ScheduleDefinitionRegistry }).default
}

async function loadRegistry(): Promise<ScheduleDefinitionRegistry> {
  try {
    return await importScheduleRegistry()
  }
  catch (cause) {
    // Without the Schedule Vite plugin, such as in plain Node, there is no generated registry.
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
