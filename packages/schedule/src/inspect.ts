import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { readRuntimeDefinitionCrons } from "./internal/provider-output.ts"

import type { ViteHubConsoleRecord, ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
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

function definitionRecord(summary: ViteHubDefinitionSummary): ViteHubConsoleRecord {
  const field = (label: string) => summary.fields.find(entry => entry.label === label)?.value
  const target = field("Kind") === "Runtime target"
  const cron = field("Cron")
  return {
    cells: {
      enabled: target ? "-" : "Provider",
      kind: target ? "Target" : "Definition",
      lastRun: target ? "-" : "Not in this table",
      nextRun: target ? "-" : "Set by the provider",
      schedule: summary.name,
      target: target ? summary.name : "-",
      timing: cron ?? "-",
    },
    fields: [
      ...summary.fields,
      { label: "File", value: summary.file },
      { label: "Source", value: summary.source },
      {
        label: "Runs",
        value: target
          ? "A Runtime Schedule that uses this target shows its runs in its own row."
          : `Use \`vitehub schedule runs ${summary.name}\` to list runs that this runtime recorded.`,
      },
    ],
    id: `definition:${summary.name}`,
    runnable: field("Manual") === "Enabled",
  }
}

/** Lists Schedule Definitions as Console records. The ids use the `definition:` prefix. */
export async function inspectScheduleConsoleRecords(options: ScheduleInspectionOptions): Promise<ViteHubConsoleRecord[]> {
  return (await inspectScheduleDefinitions(options)).map(definitionRecord)
}

/**
 * Console section for Schedules. Build-time records list discovered Schedule Definitions. Runtime records list Runtime
 * Schedules with next run, last run, and run history, read on each request. `vitehub schedule list` reads the same
 * runtime data, and `vitehub inspect definitions` reads the same Definitions.
 */
export const scheduleConsoleSection: ViteHubConsoleSectionContribution<ScheduleInspectionOptions> = {
  description: "Inspect Schedule Definitions, Runtime Schedules, and run history.",
  icon: "i-lucide-calendar-clock",
  id: "schedules",
  label: "Schedules",
  read: inspectScheduleConsoleRecords,
  runtime: { export: "readScheduleConsoleRecords", module: "@vite-hub/schedule/runtime/console" },
  view: {
    columns: [
      { key: "kind", label: "Kind" },
      { key: "schedule", label: "Schedule" },
      { key: "target", label: "Target" },
      { key: "timing", label: "Cron" },
      { key: "enabled", label: "Enabled" },
      { key: "nextRun", label: "Next run" },
      { key: "lastRun", label: "Last run" },
    ],
    kind: "record-table",
    notice: "Runtime Schedules and runs come from the Schedule stores of this server runtime on each request. Memory stores lose data on restart. Schedules with `console.enabled: false` are hidden. The Console is read-only. Use `vitehub schedule run-runtime`, `enable`, or `disable` in development.",
  },
}
