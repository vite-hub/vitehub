import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { inspectDatabaseDefinitions } from "@vite-hub/database/vite"
import { collectScheduleContributions, discoverScheduleDefinitions } from "@vite-hub/schedule/vite"

import { consoleContributedSections, consoleDocumentEditorSectionIds } from "./contributions.ts"
import { insertConsoleSection } from "./runtime/sections.ts"

import type { ConsoleSectionDiscoveryContext } from "./contributions.ts"
import type { ConsoleSectionContent } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export type ConsoleAgentEntry = { handler: string; name: string }
/** A Static Schedule Definition that sets `manual: true`. */
export type ConsoleScheduleEntry = { handler: string; name: string }

export interface ConsoleBuildCatalog {
  agents: readonly ConsoleAgentEntry[]
  manualSchedules?: readonly ConsoleScheduleEntry[]
  /** Content of the `databases` section and of each enabled contributed section, keyed by section id. */
  content: Record<ConsoleSectionId, ConsoleSectionContent>
  /** Application module of each document editor section that discovery found, such as `server/content.ts`. */
  documents?: Record<ConsoleSectionId, string>
}

/**
 * Returns the sections in navigation order with every document editor section that discovery found. A document editor
 * has no Vite option: the Console shows it when its application module exists, such as `server/content.ts`.
 */
export function withConsoleDocumentEditorSections(sections: readonly ConsoleSectionId[], catalog: Pick<ConsoleBuildCatalog, "documents">): ConsoleSectionId[] {
  let result = sections.filter(section => !consoleDocumentEditorSectionIds.includes(section))
  for (const section of consoleDocumentEditorSectionIds) {
    if (catalog.documents && Object.hasOwn(catalog.documents, section)) result = insertConsoleSection(result, section)
  }
  return result
}

/**
 * Reads section content from the owner packages. `vitehub inspect definitions` uses the same owner functions,
 * so the Console and the CLI show the same data.
 */
export async function discoverConsoleBuildCatalog(options: ConsoleSectionDiscoveryContext & {
  databaseDiscoveryRoot?: string
  sections: readonly ConsoleSectionId[]
}): Promise<ConsoleBuildCatalog> {
  const { projectRoot, sections, serverDirs } = options
  const agents = sections.includes("agents")
    ? discoverAgentDefinitionEntries(options.discoveryRoot, serverDirs)
    : []
  const content: Record<ConsoleSectionId, ConsoleSectionContent> = {}
  if (sections.includes("databases")) {
    content.databases = {
      definitions: await inspectDatabaseDefinitions({
        plugins: options.plugins,
        projectRoot,
        rootDir: options.databaseDiscoveryRoot ?? options.discoveryRoot,
        serverDirs: options.databaseDiscoveryRoot ? undefined : serverDirs,
        viteRoot: options.discoveryRoot,
      }),
      kind: "definition-catalog",
    }
  }
  for (const section of sections) {
    const contributed = consoleContributedSections.get(section)
    if (contributed && !contributed.documents) content[section] = await contributed.read(options)
  }
  const documents: Record<ConsoleSectionId, string> = {}
  for (const section of consoleDocumentEditorSectionIds) {
    const registered = consoleContributedSections.get(section)
    const entry = await registered?.documents?.entry(options)
    if (!registered || !entry) continue
    documents[section] = entry
    content[section] = await registered.read(options)
  }
  const manualSchedules = sections.includes("schedules")
    ? discoverScheduleDefinitions({
        contributions: await collectScheduleContributions(options.plugins, {
          projectRoot: options.scheduleDiscoveryRoot ?? projectRoot,
          root: options.discoveryRoot,
          serverDirs,
        }),
        rootDir: options.discoveryRoot,
        serverDirs,
        serverRootDir: options.scheduleDiscoveryRoot ?? projectRoot,
      })
        .filter(definition => definition.manual === true && definition.runtimeOnly !== true)
        .map(definition => ({ handler: definition.handler, name: definition.name }))
    : []
  return { agents, content, documents, manualSchedules }
}
