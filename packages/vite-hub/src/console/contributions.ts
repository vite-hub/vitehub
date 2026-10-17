import { describeViteHubConsoleRuntimeReader, describeViteHubConsoleSection, readViteHubConsoleSection } from "@vite-hub/internal/console"
import { emailConsoleSection } from "@vite-hub/email/vite"
import { queueConsoleSection } from "@vite-hub/queue/vite"
import { rateLimitConsoleSection } from "@vite-hub/rate-limit/vite"
import { sandboxConsoleSection } from "@vite-hub/sandbox/vite"
import { scheduleConsoleSection } from "@vite-hub/schedule/vite"
import { workflowConsoleSection } from "@vite-hub/workflow/vite"
import { workspaceConsoleSection } from "@vite-hub/workspace/vite"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ConsoleContributedSection, ConsoleSectionContent } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

/** Discovery roots that the host passes to owner section readers. */
export interface ConsoleSectionDiscoveryContext {
  discoveryRoot: string
  /** Resolved Vite plugins. Owner packages read build-time contributions from them, for example contributed Workspaces. */
  plugins?: readonly unknown[]
  projectRoot: string
  queueDiscoveryRoot?: string
  rateLimitDiscoveryRoot?: string
  rateLimitScanDirs?: string[]
  sandboxDiscoveryRoot?: string
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

export interface ConsoleRegisteredSection {
  readonly descriptor: ConsoleContributedSection
  read(context: ConsoleSectionDiscoveryContext): Promise<ConsoleSectionContent>
  /** Request-time reader. The Console adds its records to the build-time content on each request. */
  readonly runtime?: ConsoleRuntimeReader
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
  return {
    descriptor,
    read: async (context) => {
      const content: ConsoleSectionContent = await readViteHubConsoleSection(section, options(context))
      return content
    },
    ...(runtime ? { runtime: { export: runtime.export, module: consoleRuntimeReaderModule(runtime.module) } } : {}),
  }
}

/**
 * Console sections that owner packages contribute. Each owner defines the label, icon, view, and reader. This list only
 * maps the host discovery roots to the owner reader options.
 */
const registeredSections: readonly ConsoleRegisteredSection[] = [
  registerConsoleSection(emailConsoleSection, () => undefined),
  registerConsoleSection(rateLimitConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.rateLimitDiscoveryRoot ?? context.projectRoot,
    scanDirs: context.rateLimitScanDirs,
  })),
  registerConsoleSection(sandboxConsoleSection, context => ({
    projectRoot: context.projectRoot,
    rootDir: context.sandboxDiscoveryRoot ?? context.projectRoot,
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
export const consoleContributedSectionIcons: readonly string[] = [...new Set(registeredSections.map(section => section.descriptor.icon))]

export const consoleContributedSections: ReadonlyMap<ConsoleSectionId, ConsoleRegisteredSection> = new Map(
  registeredSections.map(section => [section.descriptor.id, section]),
)

export function isConsoleContributedSectionId(section: ConsoleSectionId): boolean {
  return consoleContributedSections.has(section)
}

/** Returns the descriptors of the enabled contributed sections in navigation order. */
export function describeConsoleContributedSections(sections: readonly ConsoleSectionId[]): ConsoleContributedSection[] {
  return sections.flatMap((section) => {
    const registered = consoleContributedSections.get(section)
    return registered ? [registered.descriptor] : []
  })
}

/** Returns the request-time readers of the enabled contributed sections in navigation order. */
export function describeConsoleRuntimeReaders(sections: readonly ConsoleSectionId[]): Array<ConsoleRuntimeReader & { section: ConsoleSectionId }> {
  return sections.flatMap((section) => {
    const runtime = consoleContributedSections.get(section)?.runtime
    return runtime ? [{ ...runtime, section }] : []
  })
}
