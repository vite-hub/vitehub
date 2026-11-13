import { createScheduleError } from "./errors.ts"
import { runScheduleFrom } from "./runtime/execute.ts"

import type { RunScheduleOptions } from "./runtime/execute.ts"
import type { ScheduleDefinitionRegistry, ScheduleRunRecord } from "./types.ts"

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
 * It resolves with the Schedule Run, also when the handler fails.
 */
export async function runSchedule(name: string, options: RunScheduleOptions = {}): Promise<ScheduleRunRecord> {
  return await runScheduleFrom(await loadRegistry(), name, options)
}
