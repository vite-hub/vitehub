import {
  createDirectoryDefinitionSource,
  discoverDefinitions,
} from '@vite-hub/internal/definition-catalog'
import type { ScannedDefinition } from './internal/shared/feature-definitions'

export interface DiscoveredSandboxDefinition extends ScannedDefinition {
  source: 'server-sandboxes'
}

export function discoverServerSandboxDefinitions(scanDirs: string[]): DiscoveredSandboxDefinition[] {
  return discoverDefinitions("sandbox", [
    createDirectoryDefinitionSource<DiscoveredSandboxDefinition>("server-sandboxes", scanDirs, "sandboxes", {
      createDefinition({ file, name }) {
        return {
          handler: file,
          name,
          source: "server-sandboxes",
          _meta: {
            filename: name,
            sourcePath: file,
          },
        }
      },
    }),
  ])
}
