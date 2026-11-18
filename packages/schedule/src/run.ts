import { getViteHubErrorShape } from "@vite-hub/runtime"

import { createScheduleError } from "./errors.ts"
import { runScheduleErrors } from "./run-errors.ts"
import { runScheduleFrom } from "./runtime/execute.ts"

import type { Result } from "@vite-hub/runtime"
import type { RunScheduleErrorCode } from "./run-errors.ts"
import type { RunScheduleOptions } from "./runtime/execute.ts"
import type { ScheduleDefinitionRegistry, ScheduleRunRecord } from "./types.ts"

export type { RunScheduleErrorCode } from "./run-errors.ts"
export type { RunScheduleOptions } from "./runtime/execute.ts"

// The Schedule Vite plugin turns the marked import below into `import("#vitehub/schedule/registry")`. Without the
// plugin, a bundler keeps the variable import as it is, so a build without Schedule still succeeds.
const registryModule = "#vitehub/schedule/registry"

/** The registry that the Schedule Vite plugin generates. It loads on the first run, so importing the root stays cheap. */
async function loadRegistry(): Promise<ScheduleDefinitionRegistry> {
  try {
    return (await import(/* @vite-ignore */ /* @vitehub-schedule-registry */ registryModule) as { default: ScheduleDefinitionRegistry }).default
  }
  catch (cause) {
    // Without the Schedule Vite plugin, such as in plain Node, there is no generated registry.
    throw createScheduleError("SCHEDULE_DEFINITION_NOT_FOUND", { cause })
  }
}

/**
 * Runs a Static Schedule Definition that sets `manual: true` now, as if its cron fired at `scheduledAt` (default: now).
 * It returns `[error, run]`. A failed handler is a run with `status: "failed"`, not an error. An invalid `scheduledAt`
 * or a failed run store is `error`. A Definition that does not exist or does not set `manual: true` throws.
 */
export async function runSchedule(name: string, options: RunScheduleOptions = {}): Promise<Result<ScheduleRunRecord, RunScheduleErrorCode>> {
  const registry = await loadRegistry()
  try {
    return [undefined, await runScheduleFrom(registry, name, options)]
  }
  catch (error) {
    const code = getViteHubErrorShape(error)?.code
    if (code === "SCHEDULE_DEFINITION_NOT_FOUND" || code === "SCHEDULE_MANUAL_RUN_DISABLED") throw error
    if (code === "SCHEDULE_INVALID_SCHEDULED_AT") return [runScheduleErrors.SCHEDULE_INVALID_SCHEDULED_AT({ cause: error }), undefined]
    // The handler error is in a failed run, so what is left is the run store.
    return [runScheduleErrors.SCHEDULE_RUN_STORE_FAILED({ cause: error }), undefined]
  }
}
