import { resolve } from "node:path"

import { installConsoleDefinitionScope, installConsoleSchedulesScope, resolveConsoleDefinitions, resolveConsoleSchedules } from "../../internal.ts"
import { isConsoleSectionId } from "../sections.ts"

import type { ScheduleDefinitionRegistry } from "@vite-hub/schedule"
import type { ConsoleContributedSection, ConsoleDefinitionField, ConsoleSectionCatalog, ConsoleSectionContent } from "../definitions.ts"
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
        records: content.records.map(record => ({ cells: { ...record.cells }, fields: copyFields(record.fields), id: record.id })),
      }
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
 * Installs the build-time section catalog for one project. `content` holds the data of each section. `sections` holds
 * the descriptors of the sections that owner packages contribute.
 */
export function installConsoleDefinitions(
  projectRoot: string,
  content: ConsoleSectionCatalog["content"],
  sections: ConsoleSectionCatalog["sections"] = [],
): ConsoleSectionCatalog {
  const installed: ConsoleSectionCatalog = {
    content: Object.fromEntries(
      Object.entries(content)
        .filter(([section]) => isConsoleSectionId(section))
        .map(([section, value]) => [section, copyContent(value)]),
    ),
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

/**
 * Installs the Static Schedule Definitions that the Console may run.
 * The generated Console plugin passes only `manual: true` definitions, and only with Console invocation enabled.
 */
export function installConsoleSchedules(projectRoot: string, registry: ScheduleDefinitionRegistry): ScheduleDefinitionRegistry {
  return installConsoleSchedulesScope(resolve(projectRoot), { ...registry })
}

export function getConsoleSchedules(): ScheduleDefinitionRegistry {
  return resolveConsoleSchedules() ?? {}
}
