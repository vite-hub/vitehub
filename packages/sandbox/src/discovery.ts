import { resolve } from 'node:path'
import {
  discoverDefinitions,
} from '@vitehub/internal/definition-catalog'
import type { ScannedDefinition } from './internal/shared/feature-definitions'

export interface DiscoveredSandboxDefinition extends ScannedDefinition {
  source: 'nitro-server-sandboxes'
}

export function discoverNitroSandboxDefinitions(scanDirs: string[]): DiscoveredSandboxDefinition[] {
  return discoverDefinitions("sandbox", [{
    createDefinition({ file, name }) {
      return {
        handler: file,
        name,
        source: "nitro-server-sandboxes",
        _meta: {
          filename: name,
          sourcePath: file,
        },
      }
    },
    kind: "directory",
    scanDirs,
    source: "nitro-server-sandboxes",
    subdir: "sandboxes",
  }])
}
