import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, relative, resolve as resolveFs, sep } from 'pathe'
import type { Nitro } from 'nitro/types'

export interface ScannedDefinition {
  name: string
  handler: string
  _meta: {
    filename: string
    sourcePath: string
  }
}

export interface FeatureScanResult {
  feature: string
  subdir: string
  definitions: ScannedDefinition[]
}

export interface FeatureSrcScanOptions {
  mode?: 'flat' | 'recursive'
  filter: (relativePath: string) => boolean
  normalizeName?: (relativePath: string) => string
}

const definitionExtensions = new Set(['.ts', '.mts', '.js', '.mjs'])

function hasSupportedDefinitionExtension(file: string) {
  for (const extension of definitionExtensions) {
    if (file.endsWith(extension))
      return true
  }
  return false
}

async function walkDefinitions(dir: string, out: string[] = []): Promise<string[]> {
  if (!existsSync(dir))
    return out

  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.'))
      continue

    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDefinitions(full, out)
      continue
    }

    if (entry.isFile() && hasSupportedDefinitionExtension(entry.name))
      out.push(full)
  }

  return out
}

async function walkFlatDefinitions(
  dir: string,
  filter: (file: string) => boolean,
  out: string[] = [],
): Promise<string[]> {
  if (!existsSync(dir))
    return out

  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.'))
      continue

    const full = join(dir, entry.name)
    if (entry.isFile() && filter(entry.name))
      out.push(full)
  }

  return out
}

export function resolveNitroScanRoots(nitro: Nitro): string[] {
  return Array.from(new Set([
    nitro.options.rootDir,
    nitro.options.srcDir ? resolveFs(nitro.options.rootDir, nitro.options.srcDir) : nitro.options.rootDir,
  ]))
}

export function normalizeDefinitionName(relativePath: string) {
  let normalized = relativePath.replace(/\\/g, '/')
  normalized = normalized.replace(/\.[a-z0-9]+$/i, '')
  normalized = normalized.replace(/\/index$/, '')
  return normalized
}

function resolveFlatDefinitionSuffix(subdir: string) {
  if (subdir === 'sandboxes')
    return '.sandbox'

  if (!subdir.endsWith('s'))
    return undefined

  return `.${subdir.slice(0, -1)}`
}

function isFlatRootDefinitionFile(file: string, subdir: string) {
  const suffix = resolveFlatDefinitionSuffix(subdir)
  if (!suffix)
    return false

  for (const extension of definitionExtensions) {
    if (file.endsWith(`${suffix}${extension}`))
      return true
  }

  return false
}

function normalizeFlatDefinitionName(relativePath: string, subdir: string) {
  const normalized = normalizeDefinitionName(relativePath)
  const suffix = resolveFlatDefinitionSuffix(subdir)
  if (!suffix || !normalized.endsWith(suffix))
    return normalized

  return normalized.slice(0, -suffix.length)
}

export function toTemplateSafeName(name: string) {
  return name.replace(/[^a-z0-9/_:-]/gi, '_').replace(/\//g, '__').replace(/:/g, '__')
}

export function createDefinitionRegistryContents(definitions: Pick<ScannedDefinition, 'name' | 'handler'>[]) {
  return [
    'const registry = {',
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: () => import(${JSON.stringify(definition.handler)}),`),
    '}',
    'export default registry',
    '',
  ].join('\n')
}

export async function loadFeatureDefinitions(options: {
  feature: string
  scanRoots: string[]
  subdir: string
  normalizeName?: (relativePath: string) => string
  srcScan?: FeatureSrcScanOptions
}): Promise<FeatureScanResult> {
  const definitions: ScannedDefinition[] = []
  const normalizeName = options.normalizeName || normalizeDefinitionName
  const scannedDirs = new Set<string>()
  const scannedFiles = new Set<string>()

  for (const scanRoot of options.scanRoots) {
    const definitionDirs = basename(scanRoot) === 'src' && options.srcScan
      ? [join(scanRoot, 'server', options.subdir)]
      : [join(scanRoot, options.subdir), join(scanRoot, 'server', options.subdir)]

    for (const definitionDir of definitionDirs) {
      if (scannedDirs.has(definitionDir))
        continue
      scannedDirs.add(definitionDir)

      const files = await walkDefinitions(definitionDir)
      for (const file of files) {
        if (scannedFiles.has(file))
          continue
        scannedFiles.add(file)

        const filename = relative(definitionDir, file).split(sep).join('/')
        definitions.push({
          name: normalizeName(filename),
          handler: file,
          _meta: {
            filename,
            sourcePath: file,
          },
        })
      }
    }

    if (basename(scanRoot) !== 'src')
      continue

    const srcScan = options.srcScan
    const files = srcScan
      ? await (srcScan.mode === 'recursive' ? walkDefinitions(scanRoot) : walkFlatDefinitions(scanRoot, file => hasSupportedDefinitionExtension(file)))
      : await walkFlatDefinitions(scanRoot, file => hasSupportedDefinitionExtension(file) && isFlatRootDefinitionFile(file, options.subdir))

    for (const file of files) {
      const filename = relative(scanRoot, file).split(sep).join('/')
      if (srcScan && !srcScan.filter(filename))
        continue

      if (scannedFiles.has(file))
        continue
      scannedFiles.add(file)

      definitions.push({
        name: srcScan?.normalizeName
          ? srcScan.normalizeName(filename)
          : normalizeFlatDefinitionName(filename, options.subdir),
        handler: file,
        _meta: {
          filename,
          sourcePath: file,
        },
      })
    }
  }

  definitions.sort((left, right) => {
    if (left.name === right.name)
      return left._meta.sourcePath.localeCompare(right._meta.sourcePath)
    return left.name.localeCompare(right.name)
  })

  assertNoDuplicateDefinitionNames(options.feature, definitions)

  return {
    feature: options.feature,
    subdir: options.subdir,
    definitions,
  }
}

export async function scanDefinitionsFromRoots(scanRoots: string[], subdir: string): Promise<ScannedDefinition[]> {
  return (await loadFeatureDefinitions({
    feature: subdir.slice(0, -1) || subdir,
    scanRoots,
    subdir,
  })).definitions
}

export function assertNoDuplicateDefinitionNames(feature: string, definitions: Pick<ScannedDefinition, 'name' | 'handler' | '_meta'>[]) {
  const seen = new Map<string, string>()
  for (const definition of definitions) {
    const existing = seen.get(definition.name)
    if (existing) {
      throw new Error(`[vitehub] Duplicate ${feature} definition "${definition.name}" found in:\n- ${existing}\n- ${definition._meta.sourcePath}`)
    }
    seen.set(definition.name, definition._meta.sourcePath)
  }
}
