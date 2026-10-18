import { describeViteHubConsoleDocumentActions, describeViteHubConsoleRuntimeReader, describeViteHubConsoleSection, isViteHubConsoleDocumentEditorSection, readViteHubConsoleSection, resolveViteHubConsoleSectionPages } from "@vite-hub/internal/console"
import { contentConsoleSection } from "@vite-hub/content/vite"
import { emailConsoleSection } from "@vite-hub/email/vite"
import { queueConsoleSection } from "@vite-hub/queue/vite"
import { rateLimitConsoleSection } from "@vite-hub/rate-limit/vite"
import { sandboxTaskConsoleSection } from "@vite-hub/sandbox-task/vite"
import { scheduleConsoleSection } from "@vite-hub/schedule/vite"
import { workflowConsoleSection } from "@vite-hub/workflow/vite"
import { workspaceConsoleSection } from "@vite-hub/workspace/vite"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ConsoleContributedSection, ConsoleSectionContent } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

/** Discovery roots that the host passes to owner section readers. */
export interface ConsoleSectionDiscoveryContext {
  contentImportBase?: string
  discoveryRoot: string
  /** Resolved Vite plugins. Owner packages read build-time contributions from them, for example contributed Workspaces. */
  plugins?: readonly unknown[]
  projectRoot: string
  queueDiscoveryRoot?: string
  rateLimitDiscoveryRoot?: string
  rateLimitScanDirs?: string[]
  sandboxTaskDiscoveryRoot?: string
  scheduleDiscoveryRoot?: string
  serverDirs?: string[]
  workspaceDiscoveryRoot?: string
  workflowDiscoveryRoot?: string
}

/** Server module export that reads section records on each Console request. */
export interface ConsoleRuntimeReader {
  /** Named export that returns the runtime records. */
  export: string
  /** `vite-hub` module specifier that the generated Nitro plugin imports. */
  module: string
}

/** How the host installs a document editor section. */
export interface ConsoleDocumentEditorRegistration {
  /** Owner factory export, mapped to its `vite-hub/_internal` module. */
  readonly actions: ConsoleRuntimeReader
  /** Finds the application module that the actions open. The section is shown only when it finds one. */
  entry(context: ConsoleSectionDiscoveryContext): Promise<string | undefined>
}

export interface ConsoleRegisteredSection {
  readonly descriptor: ConsoleContributedSection
  read(context: ConsoleSectionDiscoveryContext): Promise<ConsoleSectionContent>
  /** Request-time reader. The Console adds its records to the build-time content on each request. */
  readonly runtime?: ConsoleRuntimeReader
  /** Present for a document editor section. */
  readonly documents?: ConsoleDocumentEditorRegistration
}

/**
 * Maps an owner runtime module to the `vite-hub/_internal` re-export. Applications depend on `vite-hub`, so the
 * generated plugin cannot import owner packages directly.
 */
export function consoleRuntimeReaderModule(module: string): string {
  return module.replace(/^@vite-hub\//, "vite-hub/_internal/")
}

function registerConsoleSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
  options: (context: ConsoleSectionDiscoveryContext) => TOptions,
): ConsoleRegisteredSection {
  const descriptor: ConsoleContributedSection = describeViteHubConsoleSection(section)
  const runtime = describeViteHubConsoleRuntimeReader(section)
  const actions = describeViteHubConsoleDocumentActions(section)
  const registered: { -readonly [K in keyof ConsoleRegisteredSection]: ConsoleRegisteredSection[K] } = {
    descriptor,
    read: async (context) => {
      const content: ConsoleSectionContent = await readViteHubConsoleSection(section, options(context))
      return content
    },
  }
  if (runtime) registered.runtime = { export: runtime.export, module: consoleRuntimeReaderModule(runtime.module) }
  if (actions && isViteHubConsoleDocumentEditorSection(section)) {
    registered.documents = {
      actions: { export: actions.export, module: consoleRuntimeReaderModule(actions.module) },
      entry: async context => await section.entry(options(context)),
    }
  }
  return registered
}

/**
 * Console sections that owner packages contribute. Each owner defines the label, icon, view, and reader. This list only
 * maps the host discovery roots to the owner reader options.
 */
const registeredSections: readonly ConsoleRegisteredSection[] = [
  registerConsoleSection(contentConsoleSection, context => ({
    contentImportBase: context.contentImportBase,
    projectRoot: context.projectRoot,
    serverDirs: context.serverDirs,
  })),
  registerConsoleSection(emailConsoleSection, () => undefined),
  registerConsoleSection(rateLimitConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.rateLimitDiscoveryRoot ?? context.projectRoot,
    scanDirs: context.rateLimitScanDirs,
  })),
  registerConsoleSection(sandboxTaskConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.sandboxTaskDiscoveryRoot ?? context.projectRoot,
  })),
  registerConsoleSection(workspaceConsoleSection, context => ({
    plugins: context.plugins,
    projectRoot: context.projectRoot,
    rootDir: context.discoveryRoot,
    serverDirs: context.serverDirs,
    serverRootDir: context.workspaceDiscoveryRoot ?? context.projectRoot,
  })),
  registerConsoleSection(workflowConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.workflowDiscoveryRoot ?? context.discoveryRoot,
    serverDirs: context.serverDirs,
  })),
  registerConsoleSection(queueConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.queueDiscoveryRoot ?? context.discoveryRoot,
    serverDirs: context.serverDirs,
  })),
  registerConsoleSection(scheduleConsoleSection, context => ({
    plugins: context.plugins,
    projectRoot: context.projectRoot,
    rootDir: context.discoveryRoot,
    serverDirs: context.serverDirs,
    serverRootDir: context.scheduleDiscoveryRoot ?? context.projectRoot,
  })),
]

/**
 * Iconify names that the contributed sections use. Owner packages declare these icons outside the Console icon scan, so
 * the Console build (`console.vite.config.ts`) bundles this list. The prebuilt Console then never fetches an icon at
 * runtime.
 */
export const consoleContributedSectionIcons: readonly string[] = [...new Set(registeredSections.flatMap(section => [section.descriptor.icon, ...section.descriptor.pages?.map(page => page.icon) ?? []]))]

export const consoleContributedSections: ReadonlyMap<ConsoleSectionId, ConsoleRegisteredSection> = new Map(
  registeredSections.map(section => [section.descriptor.id, section]),
)

export function isConsoleContributedSectionId(section: ConsoleSectionId): boolean {
  return consoleContributedSections.has(section)
}

/**
 * Returns the descriptors of the enabled contributed sections in navigation order. Each keeps only the pages whose
 * required sections are enabled too, such as Content Media with Blob.
 */
export function describeConsoleContributedSections(sections: readonly ConsoleSectionId[]): ConsoleContributedSection[] {
  return sections.flatMap((section) => {
    const registered = consoleContributedSections.get(section)
    if (!registered) return []
    const { pages: _pages, ...descriptor } = registered.descriptor
    const pages = resolveViteHubConsoleSectionPages(registered.descriptor, sections)
    return [pages.length ? { ...descriptor, pages } : descriptor]
  })
}

/** Returns the request-time readers of the enabled contributed sections in navigation order. */
export function describeConsoleRuntimeReaders(sections: readonly ConsoleSectionId[]): Array<ConsoleRuntimeReader & { section: ConsoleSectionId }> {
  return sections.flatMap((section) => {
    const runtime = consoleContributedSections.get(section)?.runtime
    return runtime ? [{ ...runtime, section }] : []
  })
}

/** Ids of the contributed document editor sections. Discovery adds each one whose application module exists. */
export const consoleDocumentEditorSectionIds: readonly ConsoleSectionId[] = registeredSections.flatMap(section => section.documents ? [section.descriptor.id] : [])

/** Returns the document editor sections of the enabled sections with their application module, in navigation order. */
export function describeConsoleDocumentEditors(
  sections: readonly ConsoleSectionId[],
  entries: Readonly<Record<ConsoleSectionId, string>>,
): Array<ConsoleRuntimeReader & { entry: string, section: ConsoleSectionId }> {
  return sections.flatMap((section) => {
    const documents = consoleContributedSections.get(section)?.documents
    const entry = Object.hasOwn(entries, section) ? entries[section] : undefined
    return documents && entry ? [{ ...documents.actions, entry, section }] : []
  })
}
