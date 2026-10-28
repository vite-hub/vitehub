import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { collectOperationContributions, createOperationRegistry, operationsOf } from "@vite-hub/internal/operations"
import { inspectDatabaseDefinitions } from "@vite-hub/database/vite"
import { collectScheduleContributions, discoverScheduleDefinitions } from "@vite-hub/schedule/vite"

import { consoleContributedSections, consoleDocumentEditorSectionIds, discoverConsoleEntrySections } from "./contributions.ts"
import { insertConsoleSection } from "./runtime/sections.ts"

import type { CollectedOperationContribution } from "@vite-hub/internal/operations"
import type { ConsoleSectionDiscoveryContext } from "./contributions.ts"
import type { ConsoleSectionContent } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export type ConsoleAgentEntry = { handler: string; name: string }
/** A Static Schedule Definition that sets `manual: true`. */
type ConsoleScheduleEntry = { handler: string; name: string }

export interface ConsoleBuildCatalog {
  agents: readonly ConsoleAgentEntry[]
  manualSchedules?: readonly ConsoleScheduleEntry[]
  /** Content of the `databases` section and of each enabled contributed section, keyed by section id. */
  content: Record<ConsoleSectionId, ConsoleSectionContent>
  /** Application module of each document editor section that discovery found, such as `server/content.ts`. */
  documents?: Record<ConsoleSectionId, string>
  /** The operations that Vite plugins contribute through `vitehub.operations`. */
  operations?: readonly CollectedOperationContribution[]
  /** Record table sections whose application module exists, such as Comments with `server/comments.ts`. */
  entries?: readonly ConsoleSectionId[]
}

/**
 * Returns the sections in navigation order with every document editor section that discovery found. A document editor
 * has no Vite option: the Console shows it when its application module exists, such as `server/content.ts`.
 */
export function withConsoleDocumentEditorSections(sections: readonly ConsoleSectionId[], catalog: Pick<ConsoleBuildCatalog, "documents" | "entries">): ConsoleSectionId[] {
  let result = sections.filter(section => !consoleDocumentEditorSectionIds.includes(section))
  for (const section of consoleDocumentEditorSectionIds) {
    if (catalog.documents && Object.hasOwn(catalog.documents, section)) result = insertConsoleSection(result, section)
  }
  for (const section of catalog.entries ?? []) result = insertConsoleSection(result, section)
  return result
}

/**
 * Fails the build when two operations share a name. A contribution that the build cannot import by name is skipped here
 * and checked again when the app starts.
 */
export async function assertUniqueOperationNames(contributions: readonly CollectedOperationContribution[]): Promise<void> {
  const { consoleOperations } = await import("./runtime/server/operations.ts")
  const sources: Array<{ operations: ReturnType<typeof operationsOf>, plugin: string }> = [{ operations: [...consoleOperations], plugin: "vite-hub" }]
  for (const contribution of contributions) {
    try {
      const exported = contribution.load ? await contribution.load() : Reflect.get(Object(await import(/* @vite-ignore */ contribution.module)), contribution.export)
      sources.push({ operations: operationsOf(exported), plugin: contribution.plugin })
    }
    catch {
      // The app resolves its own modules. The generated plugin imports them and checks again at start.
    }
  }
  createOperationRegistry(sources)
}

/**
 * Reads section content from the owner packages. `vitehub inspect definitions` uses the same owner functions,
 * so the Console and the CLI show the same data.
 */
export async function discoverConsoleBuildCatalog(options: ConsoleSectionDiscoveryContext & {
  databaseDiscoveryRoot?: string
  /** List the implicit default Database when the app has no Database Definition. The Vite Database plugin uses one. */
  databaseImplicitDefault?: boolean
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
        implicitDefault: options.databaseImplicitDefault,
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
  // The Schedule Definitions that run, or none when the project does not enable Schedule.
  const schedules = sections.includes("schedules")
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
    : undefined
  const documents: Record<ConsoleSectionId, string> = {}
  for (const section of consoleDocumentEditorSectionIds) {
    const registered = consoleContributedSections.get(section)
    const entry = await registered?.documents?.entry(options)
    if (!registered || !entry) continue
    documents[section] = entry
    const read = await registered.read(options)
    const setup = await registered.documents?.inspect?.({ ...options, scheduleDefinitions: schedules?.map(definition => definition.handler) }, entry)
    content[section] = read.kind === "document-editor" && setup && Object.keys(setup).length ? { ...read, setup } : read
  }
  const entries = await discoverConsoleEntrySections(options)
  for (const section of entries) content[section] = await consoleContributedSections.get(section)!.read(options)
  const manualSchedules = (schedules ?? [])
    .filter(definition => definition.manual === true)
    .map(definition => ({ handler: definition.handler, name: definition.name }))
  const contributed = await collectOperationContributions(await flattenPluginOptions(options.plugins))
  await assertUniqueOperationNames(contributed)
  const operations = contributed.filter(contribution => contribution.runtime !== false)
  return { agents, content, documents, entries, manualSchedules, operations }
}
