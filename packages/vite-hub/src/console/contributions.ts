import { describeViteHubConsoleSection, readViteHubConsoleSection } from "@vite-hub/internal/console"
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

export interface ConsoleRegisteredSection {
  readonly descriptor: ConsoleContributedSection
  read(context: ConsoleSectionDiscoveryContext): Promise<ConsoleSectionContent>
}

function registerConsoleSection<TOptions>(
  section: ViteHubConsoleSectionContribution<TOptions>,
  options: (context: ConsoleSectionDiscoveryContext) => TOptions,
): ConsoleRegisteredSection {
  const descriptor: ConsoleContributedSection = describeViteHubConsoleSection(section)
  return {
    descriptor,
    read: async (context) => {
      const content: ConsoleSectionContent = await readViteHubConsoleSection(section, options(context))
      return content
    },
  }
}

/**
 * Console sections that owner packages contribute. Each owner defines the label, icon, view, and reader. This list only
 * maps the host discovery roots to the owner reader options.
 */
const registeredSections: readonly ConsoleRegisteredSection[] = [
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
