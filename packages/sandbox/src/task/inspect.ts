import { relativeDefinitionFile } from '@vite-hub/internal/inspect'

import { defaultCloudflareSandboxBinding, defaultCloudflareSandboxClassName, type CloudflareSandboxEntrypointOptions } from './cloudflare'
import { discoverSandboxTaskDefinitions } from './discovery'

import type { ViteHubConsoleSectionContribution } from '@vite-hub/internal/console'
import type { ViteHubDefinitionSummary, ViteHubResourceSummary } from '@vite-hub/internal/inspect'

export interface SandboxTaskInspectionOptions {
  projectRoot: string
  rootDir: string
}

/** Lists Sandbox Task Definitions and package entries as serializable inspection summaries. */
export function inspectSandboxTaskDefinitions(options: SandboxTaskInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverSandboxTaskDefinitions({ rootDir: options.rootDir }).map(definition => ({
    fields: [{ label: 'Kind', value: definition.kind === 'package-entry' ? 'Package entry' : 'Definition' }],
    file: relativeDefinitionFile(options.projectRoot, definition.handler),
    name: definition.name,
    source: definition.source,
  }))
}

/** Lists the Cloudflare Durable Object and Container that run every Sandbox Task. Reads build options only. */
export function inspectSandboxTaskResources(options: CloudflareSandboxEntrypointOptions): ViteHubResourceSummary[] {
  const binding = options.binding || defaultCloudflareSandboxBinding
  const className = options.className || defaultCloudflareSandboxClassName
  return [
    {
      binding,
      definition: 'Sandbox Tasks',
      host: 'cloudflare',
      kind: 'cloudflare-durable-object',
      name: className,
      note: 'One Durable Object for each Sandbox ID. It starts the Container. Wrangler creates the class from the migration in the generated wrangler.json.',
      owner: 'sandbox',
      source: 'name',
    },
    {
      definition: 'Sandbox Tasks',
      host: 'cloudflare',
      kind: 'cloudflare-container',
      name: options.name || className,
      note: `Wrangler builds the image from the containers entry of class ${className} in the generated wrangler.json.`,
      owner: 'sandbox',
      ...(options.name ? { source: 'name' as const } : {}),
    },
  ]
}

/** Console section that lists discovered Sandbox Task Definitions. `vitehub inspect definitions` reads the same data. */
export const sandboxTaskConsoleSection: ViteHubConsoleSectionContribution<SandboxTaskInspectionOptions> = {
  description: 'Inspect discovered Sandbox Task Definitions without starting runtime resources.',
  icon: 'i-vitehub-sandbox',
  id: 'sandbox-tasks',
  label: 'Sandbox Tasks',
  read: inspectSandboxTaskDefinitions,
  view: {
    kind: 'definition-catalog',
    notice: 'Running Sandbox Tasks, files, processes, logs, ports, and lifecycle state are not included in this build-time catalog.',
  },
}
