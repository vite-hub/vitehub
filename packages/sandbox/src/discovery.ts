import {
  createSuffixDefinitionSource,
  discoverDefinitions,
  listMatchingFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  registerDefinition,
  resolveDefinitionScanRoots,
  sortDefinitions,
} from '@vite-hub/internal/definition-catalog'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import type { ScannedDefinition } from './internal/shared/feature-definitions'

export interface DiscoveredSandboxDefinition extends ScannedDefinition {
  kind: 'definition' | 'package-entry'
  source: 'server-sandboxes' | 'vite-suffix'
}

const sandboxSuffixPattern = /\.sandbox\.(?:c|m)?[jt]s$/i
const sandboxEntrypointFilenames = [
  'index.ts',
  'index.mts',
  'index.js',
  'index.mjs',
]

function createDiscoveredSandboxDefinition(
  source: DiscoveredSandboxDefinition['source'],
  kind: DiscoveredSandboxDefinition['kind'],
) {
  return (context: { file: string, name: string }): DiscoveredSandboxDefinition => ({
    handler: context.file,
    kind,
    name: context.name,
    source,
    _meta: {
      filename: context.name,
      sourcePath: context.file,
    },
  })
}

function isServerSandboxFile(rootDir: string, file: string) {
  const path = relative(rootDir, file).replace(/\\/g, '/')
  return path.startsWith('server/sandboxes/') || path.startsWith('src/server/sandboxes/')
}

function normalizeSuffixSandboxName(rootDir: string, file: string) {
  if (isServerSandboxFile(rootDir, file))
    return undefined
  return normalizeSuffixDefinitionName(rootDir, file, sandboxSuffixPattern, { stripPrefix: 'src/' })
}

function normalizeDirectorySandboxName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file).replace(/\.sandbox$/, '')
}

export function discoverServerSandboxDefinitions(scanDirs: string[]): DiscoveredSandboxDefinition[] {
  const definitions = new Map<string, DiscoveredSandboxDefinition>()
  const createDefinition = createDiscoveredSandboxDefinition('server-sandboxes', 'package-entry')

  for (const scanDir of scanDirs) {
    const directory = resolve(scanDir, 'sandboxes')
    for (const manifest of listMatchingFiles(directory, name => name === 'package.json')) {
      const packageRoot = dirname(manifest)
      const entrypoints = sandboxEntrypointFilenames
        .map(filename => resolve(packageRoot, filename))
        .filter(file => existsSync(file))
      if (entrypoints.length === 0) {
        throw new Error(
          `[vitehub] Sandbox package "${packageRoot}" requires one ESM entrypoint: ${sandboxEntrypointFilenames.join(', ')}.`,
        )
      }
      if (entrypoints.length > 1) {
        throw new Error(
          `[vitehub] Sandbox package "${packageRoot}" has multiple entrypoints: ${entrypoints.join(', ')}.`,
        )
      }
      const file = entrypoints[0]!
      const name = normalizeDirectorySandboxName(directory, file)
      registerDefinition(definitions, createDefinition({ file, name }), 'sandbox')
    }
  }

  return sortDefinitions(definitions)
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
        createDefinition: createDiscoveredSandboxDefinition('vite-suffix', 'definition'),
      }),
    ]),
    discoverServerSandboxDefinitions(serverScanDirs),
  )
}
