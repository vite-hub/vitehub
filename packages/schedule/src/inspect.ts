import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { collectScheduleContributions } from "./contributions.ts"
import { discoverScheduleDefinitions } from "./discovery.ts"
import { readRuntimeDefinitionCrons, readStaticScheduleTimeZone } from "./internal/provider-output.ts"

import type { ViteHubConsoleRecord, ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionField, ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredScheduleDefinition } from "./types.ts"

export interface ScheduleInspectionOptions {
  /** Vite plugins that can contribute Schedule Definitions through `vitehub.schedules`. */
  plugins?: readonly unknown[]
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
  serverRootDir: string
}

function inspectTimeZone(file: string): string {
  const timeZone = readStaticScheduleTimeZone(file)
  return timeZone === null ? "Not a static string" : timeZone ?? "UTC"
}

function summarizeScheduleDefinition(
  projectRoot: string,
  definition: DiscoveredScheduleDefinition,
  crons: ReadonlyMap<string, string>,
): ViteHubDefinitionSummary {
  const cron = crons.get(definition.name)
  const fields: ViteHubDefinitionField[] = [
    { label: "Kind", value: "Static schedule" },
  ]
  if (cron) {
    fields.push(
      { label: "Cron", value: cron },
      { label: "Time zone", value: inspectTimeZone(definition.handler) },
    )
  }
  if (definition.manual) {
    fields.push({ label: "Manual", value: "Enabled" })
  }
  if (definition.contributor) {
    fields.push({ label: "Contributed by", value: definition.contributor })
  }
  if (definition.reason) {
    fields.push({ label: "Reason", value: definition.reason })
  }
  return {
    fields,
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "schedule",
  }
}

/**
 * Lists Schedule Definitions with their static cron when the Definition declares one. Contributed Definitions name the
 * plugin that added them and its reason.
 */
export async function inspectScheduleDefinitions(options: ScheduleInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const contributions = await collectScheduleContributions(options.plugins, {
    projectRoot: options.projectRoot,
    root: options.rootDir,
    serverDirs: options.serverDirs,
  })
  const definitions = discoverScheduleDefinitions({
    contributions,
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
  const timeZone = field("Time zone")
  return {
    cells: {
      manual: field("Manual") === "Enabled" ? "Yes" : "No",
      schedule: summary.name,
      target: target ? summary.name : "-",
      timing: !cron ? "-" : timeZone === "UTC" ? cron : `${cron} (${timeZone})`,
    },
    fields: [
      ...summary.fields,
      { label: "File", value: summary.file },
      { label: "Source", value: summary.source },
      { label: "Runs", value: `Use \`vitehub schedule runs ${summary.name}\` to list runs that this runtime recorded.` },
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
 * Console section for Schedules. Records list discovered Schedule Definitions. `vitehub inspect definitions` reads the
 * same Definitions, and `vitehub schedule runs <name>` lists the runs that a runtime recorded.
 */
export const scheduleConsoleSection: ViteHubConsoleSectionContribution<ScheduleInspectionOptions> = {
  description: "Inspect Schedule Definitions.",
  icon: "i-lucide-calendar-clock",
  id: "schedules",
  label: "Schedules",
  read: inspectScheduleConsoleRecords,
  view: {
    columns: [
      { key: "schedule", label: "Schedule" },
      { key: "timing", label: "Cron" },
      { key: "manual", label: "Manual" },
    ],
    kind: "record-table",
    notice: "The host runs each Schedule on its UTC cron. Definitions with `manual: true` can also run from the Console or `vitehub schedule run`.",
  },
}
