import { getScheduleRuntimeRegistry, loadScheduleDefinition } from "./state.ts"

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
  const registry = getScheduleRuntimeRegistry()
  if (!registry) return []
  const records = await Promise.all(Object.keys(registry).map(async (name): Promise<ViteHubConsoleRecord[]> => {
    const definition = await loadScheduleDefinition(name)
    if (!definition) return []
    const timeZone = definition.timeZone ?? "UTC"
    return [{
      cells: { schedule: name, timing: scheduleConsoleTiming(definition.cron, timeZone) },
      fields: [{ label: "Cron", value: definition.cron }, { label: "Time zone", value: timeZone }],
      id: `definition:${name}`,
    }]
  }))
  return records.flat()
}
