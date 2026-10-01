import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { readRuntimeDefinitionCrons } from "./internal/provider-output.ts"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredScheduleDefinition } from "./types.ts"

export interface ScheduleInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
  serverRootDir: string
}

function summarizeScheduleDefinition(
  projectRoot: string,
  definition: DiscoveredScheduleDefinition,
  crons: ReadonlyMap<string, string>,
): ViteHubDefinitionSummary {
  const cron = crons.get(definition.name)
  const fields: ViteHubDefinitionField[] = [
    { label: "Kind", value: definition.runtimeOnly ? "Runtime target" : "Static schedule" },
  ]
  if (cron) {
    fields.push(
      { label: "Cron", value: cron },
      { label: "Time zone", value: "UTC" },
    )
  }
  if (definition.allowRuntimeSchedules) {
    fields.push({ label: "Runtime schedules", value: "Allowed" })
  }
  if (definition.manual) {
    fields.push({ label: "Manual", value: "Enabled" })
  }
  return {
    fields,
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "schedule",
  }
}

/** Lists Schedule Definitions with their static cron when the Definition declares one. */
export async function inspectScheduleDefinitions(options: ScheduleInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const definitions = discoverScheduleDefinitions({
    rootDir: options.rootDir,
    serverDirs: options.serverDirs,
    serverRootDir: options.serverRootDir,
  })
  const crons = new Map<string, string>()
  for (const definition of definitions) {
    try {
      for (const [name, cron] of await readRuntimeDefinitionCrons([definition])) crons.set(name, cron)
    }
    catch {
      // Inspection must not apply provider-output validation to runtime-valid Schedule Definitions.
    }
  }
  return definitions.map(definition => summarizeScheduleDefinition(options.projectRoot, definition, crons))
}

/** Console section that lists discovered Schedule Definitions. `vitehub inspect definitions` reads the same data. */
export const scheduleConsoleSection: ViteHubConsoleSectionContribution<ScheduleInspectionOptions> = {
  description: "Inspect discovered Schedule Definitions and static timing metadata.",
  icon: "i-lucide-calendar-clock",
  id: "schedules",
  label: "Schedules",
  read: inspectScheduleDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "Runtime-created Schedules and run history are not included in this build-time Definition catalog yet.",
  },
}
