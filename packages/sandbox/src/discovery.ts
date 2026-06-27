import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from '@vite-hub/internal/definition-catalog'
import { resolve } from 'pathe'
import type { ScannedDefinition } from './internal/shared/feature-definitions'

export interface DiscoveredSandboxDefinition extends ScannedDefinition {
  source: 'server-sandboxes' | 'vite-suffix'
}

const sandboxSuffixPattern = /\.sandbox\.(?:c|m)?[jt]s$/i

function createDiscoveredSandboxDefinition(source: DiscoveredSandboxDefinition['source']) {
  return (context: { file: string, name: string }): DiscoveredSandboxDefinition => ({
    handler: context.file,
    name: context.name,
    source,
    _meta: {
      filename: context.name,
      sourcePath: context.file,
    },
  })
}

function normalizeSuffixSandboxName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, sandboxSuffixPattern, { stripPrefix: 'src/' })
}

function normalizeDirectorySandboxName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file)
}

export function discoverServerSandboxDefinitions(scanDirs: string[]): DiscoveredSandboxDefinition[] {
  return discoverDefinitions("sandbox", [
    createDirectoryDefinitionSource<DiscoveredSandboxDefinition>("server-sandboxes", scanDirs, "sandboxes", {
      createDefinition: createDiscoveredSandboxDefinition('server-sandboxes'),
      normalizeName: normalizeDirectorySandboxName,
    }),
  ])
}

export function discoverSandboxDefinitions(options:
  | { mode?: 'vite-suffix', rootDir: string, scanDirs?: string[] }
  | { mode: 'server-sandboxes', scanDirs: string[] }
): DiscoveredSandboxDefinition[] {
  if (options.mode === 'server-sandboxes')
    return discoverServerSandboxDefinitions(options.scanDirs)

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = roots.map(root => resolve(root, 'server'))

  return mergeDefinitions(
    'sandbox',
    discoverDefinitions('sandbox', [
      createSuffixDefinitionSource('vite-suffix', roots, sandboxSuffixPattern, normalizeSuffixSandboxName, {
        createDefinition: createDiscoveredSandboxDefinition('vite-suffix'),
      }),
    ]),
    discoverDefinitions('sandbox', [
      createDirectoryDefinitionSource('server-sandboxes', serverScanDirs, 'sandboxes', {
        createDefinition: createDiscoveredSandboxDefinition('server-sandboxes'),
        normalizeName: normalizeDirectorySandboxName,
      }),
    ]),
  )
}
