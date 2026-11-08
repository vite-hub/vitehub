import { getProcessScheduleDefinitions, getStartedScheduleRuntime } from "./state.ts"

import type { ViteHubConsoleRecord } from "@vite-hub/internal/console"
import type { StartedSchedule } from "../types.ts"

/** The Cron column of the Console: the cron, with the time zone when it is not UTC. */
export function scheduleConsoleTiming(cron: string, timeZone: string): string {
  return timeZone === "UTC" ? cron : `${cron} (${timeZone})`
}

function startedScheduleRecord(schedule: StartedSchedule): ViteHubConsoleRecord {
  const timeZone = schedule.timeZone ?? "UTC"
  const timing = schedule.at ? `once at ${schedule.at.toISOString()}` : scheduleConsoleTiming(schedule.cron ?? "", timeZone)
  return {
    cells: { manual: "-", schedule: `${schedule.name} (${schedule.id})`, timing },
    fields: [
      { label: "Kind", value: "Started schedule" },
      { label: "ID", value: schedule.id },
      { label: "Definition", value: schedule.name },
      ...(schedule.at ? [{ label: "Runs at", value: schedule.at.toISOString() }] : [{ label: "Cron", value: schedule.cron ?? "" }, { label: "Time zone", value: timeZone }]),
      { label: "Started at", value: schedule.createdAt.toISOString() },
      { label: "Payload", value: schedule.payload === undefined ? "-" : JSON.stringify(schedule.payload) },
      { label: "Runs", value: `Use \`vitehub schedule runs ${schedule.id}\` to list its runs, and \`vitehub schedule cancel ${schedule.id}\` to stop it.` },
    ],
    id: `started:${schedule.id}`,
  }
}

/**
 * The cron and time zone of each Schedule that this process runs, read from the loaded Definitions on each Console
 * request, and one record for each Schedule that code started with `startSchedule()`. Each Definition record updates the
 * build-time record of its Schedule. Without a Process Runtime, provider cron output uses the static UTC cron that the
 * build checked.
 */
export async function readScheduleConsoleRecords(): Promise<ViteHubConsoleRecord[]> {
  const definitions = getProcessScheduleDefinitions()
  const records = [...definitions ?? []].flatMap(([name, definition]) => {
    if (definition.cron === undefined) return []
    const timeZone = definition.timeZone ?? "UTC"
    return [{
      cells: { schedule: name, timing: scheduleConsoleTiming(definition.cron, timeZone) },
      fields: [{ label: "Cron", value: definition.cron }, { label: "Time zone", value: timeZone }],
      id: `definition:${name}`,
    }]
  })
  const started = getStartedScheduleRuntime()
  if (!started) return records
  return [...records, ...(await started.store.list()).map(startedScheduleRecord)]
}
