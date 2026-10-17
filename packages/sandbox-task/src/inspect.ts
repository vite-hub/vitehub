import { relativeDefinitionFile } from '@vite-hub/internal/inspect'

import { discoverSandboxTaskDefinitions } from './discovery'

import type { ViteHubConsoleSectionContribution } from '@vite-hub/internal/console'
import type { ViteHubDefinitionSummary } from '@vite-hub/internal/inspect'

export interface SandboxTaskInspectionOptions {
  projectRoot: string
  rootDir: string
}

/** Lists Sandbox Definitions and package entries as serializable inspection summaries. */
export function inspectSandboxTaskDefinitions(options: SandboxTaskInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverSandboxTaskDefinitions({ rootDir: options.rootDir }).map(definition => ({
    fields: [{ label: 'Kind', value: definition.kind === 'package-entry' ? 'Package entry' : 'Definition' }],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source,
  }))
}

/** Console section that lists discovered Sandbox Definitions. `vitehub inspect definitions` reads the same data. */
export const sandboxTaskConsoleSection: ViteHubConsoleSectionContribution<SandboxTaskInspectionOptions> = {
  description: 'Inspect discovered Sandbox Definitions without starting runtime resources.',
  icon: 'i-lucide-container',
  id: 'sandbox-tasks',
  label: 'Sandboxes',
  read: inspectSandboxTaskDefinitions,
  view: {
    kind: 'definition-catalog',
    notice: 'Running Sandboxes, files, processes, logs, ports, and lifecycle state are not included in this build-time catalog.',
  },
}
