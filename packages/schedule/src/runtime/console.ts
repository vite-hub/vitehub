import { getProcessScheduleDefinitions } from "./state.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"

/** The Cron column of the Console: the cron, with the time zone when it is not UTC. */
export function scheduleConsoleTiming(cron: string, timeZone: string): string {
  return timeZone === "UTC" ? cron : `${cron} (${timeZone})`
}

/**
 * The cron and time zone of each Schedule that this process runs, read from the loaded Definitions on each Console
 * request. Each record updates the build-time record of its Schedule. It is empty when this process has no Process
 * Runtime: provider cron output then uses the static UTC cron that the build checked.
 */
export async function readScheduleConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const definitions = getProcessScheduleDefinitions()
  if (!definitions) return []
  return [...definitions].map(([name, definition]) => {
    const timeZone = definition.timeZone ?? "UTC"
    return {
      cells: { schedule: name, timing: scheduleConsoleTiming(definition.cron, timeZone) },
      fields: [{ label: "Cron", value: definition.cron }, { label: "Time zone", value: timeZone }],
      id: `definition:${name}`,
    }
  })
}
