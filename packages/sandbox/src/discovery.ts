import { resolve } from 'node:path'
import {
  createRuntimeRegistryContents,
  listSourceFiles,
  normalizePathDefinitionName,
  registerDefinition,
  sortDefinitions,
} from '@vitehub/internal/definition-discovery'
import type { ScannedDefinition } from './internal/shared/feature-definitions'

export interface DiscoveredSandboxDefinition extends ScannedDefinition {
  source: 'nitro-server-sandboxes'
}

export function discoverNitroSandboxDefinitions(scanDirs: string[]): DiscoveredSandboxDefinition[] {
  const definitions = new Map<string, DiscoveredSandboxDefinition>()

  for (const scanDir of scanDirs) {
    const sandboxDir = resolve(scanDir, 'sandboxes')
    for (const file of listSourceFiles(sandboxDir)) {
      const name = normalizePathDefinitionName(sandboxDir, file)
      if (!name)
        continue

      registerDefinition(definitions, {
        handler: file,
        name,
        source: 'nitro-server-sandboxes',
        _meta: {
          filename: name,
          sourcePath: file,
        },
      }, 'sandbox')
    }
  }

  return sortDefinitions(definitions)
}

export function createSandboxNitroRegistryContents(registryFile: string, definitions: Array<{ handler: string, name: string }>) {
  return createRuntimeRegistryContents(registryFile, definitions)
}
