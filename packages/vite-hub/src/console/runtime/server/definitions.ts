import { resolve } from "node:path"

import { installConsoleDefinitionScope, installConsoleSchedulesScope, resolveConsoleDefinitions, resolveConsoleSchedules } from "../../internal.ts"
import { isConsoleSectionId } from "../sections.ts"

import type { ConsoleContributedSection, ConsoleDefinitionField, ConsoleRecord, ConsoleSectionCatalog, ConsoleSectionContent } from "../definitions.ts"
import type { ScheduleDefinitionRegistry } from "@vite-hub/schedule"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

function copyFields(fields: readonly ConsoleDefinitionField[]): ConsoleDefinitionField[] {
  return fields.map(field => ({ label: field.label, value: field.value }))
}

function copyContent(content: ConsoleSectionContent): ConsoleSectionContent {
  return content.kind === "definition-catalog"
    ? {
        definitions: content.definitions.map(definition => ({ ...definition, fields: copyFields(definition.fields) })),
        kind: "definition-catalog",
      }
    : {
        kind: "record-table",
        records: copyConsoleRecords(content.records),
      }
}

/** Copies request-time records so that the reader cannot change the response after it returns. */
export function copyConsoleRecords(records: readonly ConsoleRecord[]): ConsoleRecord[] {
  return records.map((record) => {
    const copied: ConsoleRecord = {
      cells: { ...record.cells },
      fields: copyFields(record.fields),
      id: record.id,
    }
    if (record.runnable === true) {
      copied.runnable = true
    }
    return copied
  })
}

function copySection(section: ConsoleContributedSection): ConsoleContributedSection {
  return {
    ...section,
    view: section.view.kind === "definition-catalog"
      ? { kind: "definition-catalog", notice: section.view.notice }
      : { columns: section.view.columns.map(column => ({ ...column })), kind: "record-table", notice: section.view.notice },
  }
}

/**
 * Installs the section catalog for one project. `content` holds the build-time data of each section. `sections` holds
 * the descriptors of the sections that owner packages contribute. `readers` holds the request-time readers of
 * record-table sections. The Console calls them on each definitions request.
 */
export function installConsoleDefinitions(
  projectRoot: string,
  content: ConsoleSectionCatalog["content"],
  sections: ConsoleSectionCatalog["sections"] = [],
  readers: NonNullable<ConsoleSectionCatalog["readers"]> = {},
): ConsoleSectionCatalog {
  const installed: ConsoleSectionCatalog = {
    content: Object.fromEntries(
      Object.entries(content)
        .filter(([section]) => isConsoleSectionId(section))
        .map(([section, value]) => [section, copyContent(value)]),
    ),
    readers: Object.fromEntries(Object.entries(readers).filter(([section]) => isConsoleSectionId(section))),
    sections: sections.filter(section => isConsoleSectionId(section.id)).map(copySection),
  }
  return installConsoleDefinitionScope(resolve(projectRoot), installed)
}

export function getConsoleDefinitions(): ConsoleSectionCatalog {
  const catalog = resolveConsoleDefinitions()
  if (!catalog) {
    throw viteHubErrorDiagnostics.VITE_HUB_C0002({ message: "[vitehub] Definition inspection has not been installed for this runtime." })
  }
  return catalog
}

/** Returns the installed descriptors of contributed sections, or an empty list when no catalog is installed. */
export function getConsoleContributedSections(): readonly ConsoleContributedSection[] {
  return resolveConsoleDefinitions()?.sections ?? []
}

/** Installs the Static Schedule Definitions that the Console may run. */
export function installConsoleSchedules(projectRoot: string, registry: ScheduleDefinitionRegistry): ScheduleDefinitionRegistry {
  return installConsoleSchedulesScope(resolve(projectRoot), { ...registry })
}

export function getConsoleSchedules(): ScheduleDefinitionRegistry {
  return resolveConsoleSchedules() ?? {}
}
