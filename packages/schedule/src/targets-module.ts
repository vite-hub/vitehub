import type { DiscoveredScheduleDefinition } from "./types.ts"

export const SCHEDULE_TARGETS_ID = "#vitehub/schedule/targets"

function getScheduleTargetNames(definitions: Pick<DiscoveredScheduleDefinition, "allowRuntimeSchedules" | "name">[]): string[] {
  return definitions
    .filter(definition => definition.allowRuntimeSchedules)
    .map(definition => definition.name)
    .sort()
}

export function createScheduleTargetsContents(definitions: Pick<DiscoveredScheduleDefinition, "allowRuntimeSchedules" | "name">[], options: { types?: boolean } = {}): string {
  const targets = getScheduleTargetNames(definitions)
  const union = targets.length ? targets.map(target => JSON.stringify(target)).join(" | ") : "never"

  return [
    `export const scheduleTargetNames = ${JSON.stringify(targets)};`,
    options.types ? `export type ScheduleTargetName = ${union};` : "",
    "",
  ].filter(line => line !== "").join("\n")
}
