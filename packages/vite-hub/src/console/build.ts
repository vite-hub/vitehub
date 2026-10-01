import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { inspectDatabaseDefinitions } from "@vite-hub/database/vite"
import { discoverScheduleDefinitions } from "@vite-hub/schedule/vite"

import { consoleContributedSections } from "./contributions.ts"

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
      definitions: inspectDatabaseDefinitions({
        projectRoot,
        rootDir: options.databaseDiscoveryRoot ?? options.discoveryRoot,
        serverDirs: options.databaseDiscoveryRoot ? undefined : serverDirs,
      }),
      kind: "definition-catalog",
    }
  }
  for (const section of sections) {
    const contributed = consoleContributedSections.get(section)
    if (contributed) content[section] = await contributed.read(options)
  }
  const manualSchedules = sections.includes("schedules")
    ? discoverScheduleDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs,
        serverRootDir: options.scheduleDiscoveryRoot ?? projectRoot,
      })
        .filter(definition => definition.manual === true && definition.runtimeOnly !== true)
        .map(definition => ({ handler: definition.handler, name: definition.name }))
    : []
  return { agents, content, manualSchedules }
}
