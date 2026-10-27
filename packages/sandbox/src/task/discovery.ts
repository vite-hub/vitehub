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
import { sandboxTaskErrorDiagnostics } from "./error-diagnostics.ts"

export interface DiscoveredSandboxTaskDefinition extends ScannedDefinition {
  kind: 'definition' | 'package-entry'
  source: 'server-sandbox-tasks' | 'vite-suffix'
}

const sandboxTaskSuffixPattern = /\.sandbox-task\.(?:c|m)?[jt]s$/i
const sandboxTaskEntrypointFilenames = [
  'index.ts',
  'index.mts',
  'index.js',
  'index.mjs',
]

function createDiscoveredSandboxTaskDefinition(
  source: DiscoveredSandboxTaskDefinition['source'],
  kind: DiscoveredSandboxTaskDefinition['kind'],
) {
  return (context: { file: string, name: string }): DiscoveredSandboxTaskDefinition => ({
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

function isServerSandboxTaskFile(rootDir: string, file: string) {
  const path = relative(rootDir, file).replace(/\\/g, '/')
  return path.startsWith('server/sandbox-tasks/') || path.startsWith('src/server/sandbox-tasks/')
}

function normalizeSuffixSandboxTaskName(rootDir: string, file: string) {
  if (isServerSandboxTaskFile(rootDir, file))
    return undefined
  return normalizeSuffixDefinitionName(rootDir, file, sandboxTaskSuffixPattern, { stripPrefix: 'src/' })
}

function normalizeDirectorySandboxTaskName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file).replace(/\.sandbox-task$/, '')
}

function isNestedDirectory(parent: string, candidate: string) {
  const path = relative(parent, candidate).replace(/\\/g, '/')
  return path !== '' && path !== '..' && !path.startsWith('../')
}

export function discoverServerSandboxTaskDefinitions(scanDirs: string[]): DiscoveredSandboxTaskDefinition[] {
  const definitions = new Map<string, DiscoveredSandboxTaskDefinition>()
  const createDefinition = createDiscoveredSandboxTaskDefinition('server-sandbox-tasks', 'package-entry')

  for (const scanDir of scanDirs) {
    const directory = resolve(scanDir, 'sandbox-tasks')
    const packageRoots = listMatchingFiles(directory, name => name === 'package.json')
      .map(manifest => dirname(manifest))
      .sort((left, right) => {
        const depth = relative(directory, left).split(/[\\/]/).length - relative(directory, right).split(/[\\/]/).length
        return depth || left.localeCompare(right)
      })
    const entrypoints = new Map(packageRoots.map(packageRoot => [
      packageRoot,
      sandboxTaskEntrypointFilenames
        .map(filename => resolve(packageRoot, filename))
        .filter(file => existsSync(file)),
    ]))
    const selectedRoots: string[] = []

    for (const packageRoot of packageRoots) {
      if (selectedRoots.some(root => isNestedDirectory(root, packageRoot)))
        continue

      const packageEntrypoints = entrypoints.get(packageRoot)!
      if (packageEntrypoints.length > 1) {
        throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0009({ message: `[vitehub] Sandbox package "${packageRoot}" has multiple entrypoints: ${packageEntrypoints.join(', ')}.` })
      }
      if (packageEntrypoints.length === 0)
        continue

      const file = packageEntrypoints[0]!
      const name = normalizeDirectorySandboxTaskName(directory, file)
      registerDefinition(definitions, createDefinition({ file, name }), 'Sandbox Task')
      selectedRoots.push(packageRoot)
    }

    for (const packageRoot of packageRoots) {
      if (entrypoints.get(packageRoot)!.length > 0)
        continue
      if (selectedRoots.some(root => isNestedDirectory(packageRoot, root) || isNestedDirectory(root, packageRoot)))
        continue
      throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0010({ message: `[vitehub] Sandbox package "${packageRoot}" requires one ESM entrypoint: ${sandboxTaskEntrypointFilenames.join(', ')}.` })
    }
  }

  return sortDefinitions(definitions)
}

export function discoverSandboxTaskDefinitions(options:
  | { mode?: 'vite-suffix', rootDir: string, scanDirs?: string[] }
  | { mode: 'server-sandbox-tasks', scanDirs: string[] }
): DiscoveredSandboxTaskDefinition[] {
  if (options.mode === 'server-sandbox-tasks')
    return discoverServerSandboxTaskDefinitions(options.scanDirs)

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = roots.map(root => resolve(root, 'server'))

  return mergeDefinitions(
    'Sandbox Task',
    discoverDefinitions('Sandbox Task', [
      createSuffixDefinitionSource('vite-suffix', roots, sandboxTaskSuffixPattern, normalizeSuffixSandboxTaskName, {
        createDefinition: createDiscoveredSandboxTaskDefinition('vite-suffix', 'definition'),
      }),
    ]),
    discoverServerSandboxTaskDefinitions(serverScanDirs),
  )
}
