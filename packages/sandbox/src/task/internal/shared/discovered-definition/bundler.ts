import { createRequire, isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'
import { findDynamicImports } from 'mlly'
import type { Rolldown } from 'vite'
import { sandboxTaskErrorDiagnostics } from "../../../error-diagnostics.ts"

export interface DiscoveredDefinitionBundleOptions {
  alias?: Record<string, string>
  filename: string
  source: string
  packages?: 'bundle' | 'external'
  plugins?: Rolldown.Plugin[]
}

export interface DiscoveredDefinitionModuleGraph {
  entry: string
  externalImports: string[]
  hasRuntimeModuleResolution: boolean
  modules: Record<string, string>
}

function isJsxDefinition(filename: string) {
  return filename.endsWith('.tsx') || filename.endsWith('.jsx')
}

function isBareSpecifier(id: string) {
  return !/^(?:\.{1,2}(?:\/|$)|\/|[A-Za-z]:[\\/]|\0)/.test(id)
}

/**
 * Vite 8 bundles with Rolldown, so the app already has it. Load the copy next to `vite`, or `vite/rolldown` with
 * Vite+, instead of installing a second bundler.
 */
async function importRolldown(): Promise<typeof Rolldown> {
  let entry: string
  try {
    entry = createRequire(import.meta.resolve('vite')).resolve('rolldown')
  }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'MODULE_NOT_FOUND') throw error
    entry = createRequire(import.meta.url).resolve('vite/rolldown')
  }
  return await import(pathToFileURL(entry).href)
}

function usesRuntimeModuleResolution(contents: string) {
  return findDynamicImports(contents).some(imported => !imported.expression.startsWith('"'))
    || /\bimport\.meta\.resolve\s*\(/.test(contents)
    || /\bcreateRequire\b/.test(contents)
}

export async function bundleDiscoveredDefinitionModuleGraph(
  options: DiscoveredDefinitionBundleOptions,
): Promise<DiscoveredDefinitionModuleGraph> {
  const { rolldown } = await importRolldown()
  const aliases = Object.keys(options.alias || {})
  const bundle = await rolldown({
    input: { definition: options.filename },
    platform: 'node',
    logLevel: 'silent',
    resolve: { alias: options.alias },
    transform: {
      target: 'es2022',
      jsx: isJsxDefinition(options.filename) ? { runtime: 'automatic', importSource: 'react' } : undefined,
    },
    plugins: [
      ...(options.plugins || []),
      {
        name: 'vitehub-sandbox-task-definition-source',
        resolveId(id) {
          if (id === options.filename) return id
          if (options.packages === 'external' && isBareSpecifier(id) && !isBuiltin(id)
            && !aliases.some(alias => id === alias || id.startsWith(`${alias}/`))) {
            return { id, external: true }
          }
        },
        load(id) {
          if (id === options.filename) return options.source
        },
      },
    ],
  })
  let output: Rolldown.RolldownOutput['output']
  try {
    output = (await bundle.generate({
      format: 'esm',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
    })).output
  }
  finally {
    await bundle.close()
  }

  const chunks = output.filter(file => file.type === 'chunk')
  const modules = Object.fromEntries(chunks.map(chunk => [chunk.fileName, chunk.code]))

  if (!modules['definition.js']) {
    throw sandboxTaskErrorDiagnostics.SANDBOX_TASK_R0048({ message: `[vitehub] Failed to bundle discovered definition graph "${options.filename}".` })
  }

  const externalImports = [...new Set(chunks
    .flatMap(chunk => [...chunk.imports, ...chunk.dynamicImports])
    .filter(imported => !Object.hasOwn(modules, imported)))].sort()
  const hasRuntimeModuleResolution = Object.values(modules).some(usesRuntimeModuleResolution)

  return {
    entry: 'definition.js',
    externalImports,
    hasRuntimeModuleResolution,
    modules,
  }
}
