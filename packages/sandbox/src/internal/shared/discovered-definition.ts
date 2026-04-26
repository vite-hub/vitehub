import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'pathe'
import { createUnimport, type Import, type ScanDir } from 'unimport'

import { bundleDiscoveredDefinitionModule } from './discovered-definition/bundler'
import { injectTypeImportsFromUnimport } from './discovered-definition/ast'
import { isNitroAutoImportEnabled } from './server-imports'

import type { NitroImportsOptions } from './server-imports'
import type { ServerImport } from './runtime-artifacts'
import type { DiscoveredDefinitionBundleOptions } from './discovered-definition/bundler'

export type { DiscoveredDefinitionBundleOptions, DiscoveredDefinitionModuleGraph } from './discovered-definition/bundler'
export { bundleDiscoveredDefinitionModule, bundleDiscoveredDefinitionModuleGraph } from './discovered-definition/bundler'

export interface DiscoveredDefinitionCompilerOptions {
  rootDir: string
  scanRoots: string[]
  nitroImports?: NitroImportsOptions
  featureImports?: ServerImport[]
}

export interface DiscoveredDefinitionCompiler {
  enabled: boolean
  injectSource: (source: string, id: string) => Promise<string>
  readSource: (id: string) => Promise<string>
  bundleModule: (options: DiscoveredDefinitionBundleOptions) => Promise<string>
}

function normalizeDir(rootDir: string, dir: string | ScanDir): string | ScanDir {
  if (typeof dir === 'string')
    return isAbsolute(dir) ? dir : resolvePath(rootDir, dir)

  return {
    ...dir,
    glob: isAbsolute(dir.glob) ? dir.glob : resolvePath(rootDir, dir.glob),
  }
}

function normalizePresetImport(
  from: string,
  entry: string | { name: string, as?: string, type?: boolean },
): Import {
  if (typeof entry === 'string')
    return { from, name: entry }

  return {
    from,
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

function normalizeServerImport(entry: ServerImport): Import {
  return {
    from: entry.from,
    name: entry.name,
    ...(entry.as ? { as: entry.as } : {}),
    ...(entry.type ? { type: true } : {}),
  }
}

function resolveDefaultImportDirs(rootDir: string, scanRoots: string[]) {
  return scanRoots.flatMap(scanRoot => [
    normalizeDir(rootDir, join(scanRoot, 'server/utils/**/*')),
    normalizeDir(rootDir, join(scanRoot, 'shared/types/**/*')),
  ])
}

function isInlinePreset(value: unknown): value is {
  from: string
  imports: unknown[]
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { from?: unknown }).from === 'string'
    && Array.isArray((value as { imports?: unknown }).imports)
}

function isPresetImport(value: unknown): value is {
  name: string
  as?: string
  type?: boolean
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { name?: unknown }).name === 'string'
}

function normalizePresetImports(presets: unknown[] = []): Import[] {
  const normalized: Import[] = []

  function collect(from: string, entry: unknown) {
    if (typeof entry === 'string') {
      normalized.push(normalizePresetImport(from, entry))
      return
    }

    if (isInlinePreset(entry)) {
      for (const nested of entry.imports)
        collect(entry.from, nested)
      return
    }

    if (isPresetImport(entry))
      normalized.push(normalizePresetImport(from, entry))
  }

  for (const preset of presets) {
    if (!isInlinePreset(preset))
      continue

    for (const entry of preset.imports)
      collect(preset.from, entry)
  }

  return normalized
}

async function createInitializedUnimport(options: DiscoveredDefinitionCompilerOptions) {
  const nitroImports = options.nitroImports !== false ? options.nitroImports : undefined
  const imports = [
    ...normalizePresetImports(nitroImports?.presets),
    ...(options.featureImports || []).map(normalizeServerImport),
  ]
  const dirs = [
    ...resolveDefaultImportDirs(options.rootDir, options.scanRoots),
    ...((nitroImports?.dirs || []).map(dir => normalizeDir(options.rootDir, dir))),
  ]

  const unimport = createUnimport({
    imports,
    dirs,
  })
  await unimport.init()
  return unimport
}

export async function createDiscoveredDefinitionCompiler(
  options: Partial<DiscoveredDefinitionCompilerOptions> = {},
): Promise<DiscoveredDefinitionCompiler> {
  const resolvedOptions: DiscoveredDefinitionCompilerOptions = {
    rootDir: options.rootDir || process.cwd(),
    scanRoots: options.scanRoots || [],
    nitroImports: options.nitroImports,
    featureImports: options.featureImports || [],
  }

  if (!isNitroAutoImportEnabled(resolvedOptions.nitroImports)) {
    return {
      enabled: false,
      async injectSource(source) {
        return source
      },
      async readSource(id) {
        return await readFile(id, 'utf8')
      },
      async bundleModule(bundleOptions) {
        return await bundleDiscoveredDefinitionModule(bundleOptions)
      },
    }
  }

  const unimport = await createInitializedUnimport(resolvedOptions)
  const injectSource = async (source: string, id: string) => {
    const valueInjected = await unimport.injectImports(source, id)
    return await injectTypeImportsFromUnimport(valueInjected.code, id, await unimport.getImports())
  }
  return {
    enabled: true,
    injectSource,
    async readSource(id) {
      return await injectSource(await readFile(id, 'utf8'), id)
    },
    async bundleModule(bundleOptions) {
      return await bundleDiscoveredDefinitionModule(bundleOptions)
    },
  }
}
