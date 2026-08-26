import type { Dirent } from "node:fs"
import { readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import { relative, resolve } from "pathe"

import { generatedDirSegments } from "./build/paths.ts"

const sourceFilePattern = /\.(?:c|m)?[jt]sx?$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]sx?$/i
const ignoredDirs = new Set(["node_modules", "dist", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])

export interface DiscoveredDefinition {
  handler: string
  name: string
  source?: string
}

interface BaseDefinitionCatalogSource<TDefinition extends DiscoveredDefinition> {
  createDefinition?: (context: { file: string, name: string }) => TDefinition
  source: string
}

export interface SuffixDefinitionCatalogSource<TDefinition extends DiscoveredDefinition> extends BaseDefinitionCatalogSource<TDefinition> {
  includeHidden?: boolean
  kind: "suffix"
  normalizeName: (rootDir: string, file: string) => string | undefined
  pattern: RegExp
  roots: string[]
}

export interface DirectoryDefinitionCatalogSource<TDefinition extends DiscoveredDefinition> extends BaseDefinitionCatalogSource<TDefinition> {
  includeHidden?: boolean
  kind: "directory"
  normalizeName?: (directory: string, file: string) => string | undefined
  scanDirs: string[]
  subdir: string
}

export type DefinitionCatalogSource<TDefinition extends DiscoveredDefinition> =
  | DirectoryDefinitionCatalogSource<TDefinition>
  | SuffixDefinitionCatalogSource<TDefinition>

export function resolveDefinitionScanRoots(rootDir: string, scanDirs: string[] | undefined = []): string[] {
  return [...new Set([rootDir, ...scanDirs].filter(Boolean))]
}

export function createDirectoryDefinitionSource<TDefinition extends DiscoveredDefinition>(
  source: string,
  scanDirs: string[],
  subdir: string,
  options: Pick<DirectoryDefinitionCatalogSource<TDefinition>, "createDefinition" | "includeHidden" | "normalizeName"> = {},
): DirectoryDefinitionCatalogSource<TDefinition> {
  return {
    ...options,
    kind: "directory",
    scanDirs,
    source,
    subdir,
  }
}

export function createSuffixDefinitionSource<TDefinition extends DiscoveredDefinition>(
  source: string,
  roots: string[],
  pattern: RegExp,
  normalizeName: SuffixDefinitionCatalogSource<TDefinition>["normalizeName"],
  options: Pick<SuffixDefinitionCatalogSource<TDefinition>, "createDefinition" | "includeHidden"> = {},
): SuffixDefinitionCatalogSource<TDefinition> {
  return {
    ...options,
    kind: "suffix",
    normalizeName,
    pattern,
    roots,
    source,
  }
}

function readDirEntries(root: string): Dirent[] {
  try {
    return readdirSync(root, { withFileTypes: true })
  }
  catch (error) {
    // SAFETY: Node filesystem failures expose their stable error code through ErrnoException.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
}

export function listMatchingFiles(root: string, predicate: (name: string) => boolean, options: { includeHidden?: boolean } = {}): string[] {
  const files: string[] = []
  for (const entry of readDirEntries(root)) {
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (entry.name.startsWith(".")) {
        continue
      }
      if (ignoredDirs.has(entry.name)) {
        continue
      }
      files.push(...listMatchingFiles(absolute, predicate, options))
      continue
    }

    if (entry.name.startsWith(".") && !options.includeHidden) {
      continue
    }

    if (entry.isFile() && predicate(entry.name)) {
      files.push(absolute)
    }
  }

  return files.sort()
}

export function listSourceFiles(root: string, options: { includeHidden?: boolean } = {}): string[] {
  return listMatchingFiles(root, name => sourceFilePattern.test(name) && !declarationFilePattern.test(name), options)
}

export function normalizePathDefinitionName(rootDir: string, file: string): string {
  const relativePath = relative(rootDir, file)
  return relativePath.replace(sourceFilePattern, "").replace(/\/index$/i, "")
}

export function normalizeSuffixDefinitionName(
  rootDir: string,
  file: string,
  pattern: RegExp,
  options: { stripPrefix?: string } = {},
): string {
  const relativePath = relative(rootDir, file)
  const normalized = relativePath.replace(pattern, "")
  if (options.stripPrefix && normalized.startsWith(options.stripPrefix)) {
    return normalized.slice(options.stripPrefix.length)
  }
  return normalized
}

export function sanitizeDefinitionFilename(name: string): string {
  let result = ""
  for (const char of name) {
    if (/[a-z0-9-]/i.test(char)) {
      result += char
    }
    else if (char === "_") {
      result += "__"
    }
    else if (char === "/") {
      result += "_s"
    }
    else if (char === ":") {
      result += "_c"
    }
    else {
      result += `_x${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    }
  }
  return result
}

export function sortDefinitions<TDefinition extends DiscoveredDefinition>(definitions: Map<string, TDefinition>): TDefinition[] {
  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function registerDefinition<TDefinition extends DiscoveredDefinition>(
  definitions: Map<string, TDefinition>,
  definition: TDefinition,
  sourceLabel: string,
): void {
  const existing = definitions.get(definition.name)
  if (existing) {
    throw new Error(`Duplicate ${sourceLabel} name "${definition.name}":\n  - ${existing.handler}\n  - ${definition.handler}`)
  }

  definitions.set(definition.name, definition)
}

export function mergeDefinitions<TDefinition extends DiscoveredDefinition>(
  feature: string,
  ...sources: Array<TDefinition[] | undefined>
): TDefinition[] {
  const definitions = new Map<string, TDefinition>()

  for (const source of sources) {
    if (!source) {
      continue
    }

    for (const definition of source) {
      const existing = definitions.get(definition.name)
      if (existing && existing.handler !== definition.handler) {
        throw new Error(`Duplicate ${feature} name "${definition.name}" from multiple discovery sources:\n  - ${existing.handler} (${existing.source ?? "unknown"})\n  - ${definition.handler} (${definition.source ?? "unknown"})`)
      }

      if (!existing) {
        definitions.set(definition.name, definition)
      }
    }
  }

  return sortDefinitions(definitions)
}

function createDefinition<TDefinition extends DiscoveredDefinition>(
  source: BaseDefinitionCatalogSource<TDefinition>,
  file: string,
  name: string,
): TDefinition {
  if (source.createDefinition) {
    return source.createDefinition({ file, name })
  }

  // SAFETY: Catalog sources may refine DiscoveredDefinition without supplying a custom factory.
  return {
    handler: file,
    name,
    source: source.source,
  } as TDefinition
}

function scanSuffixDefinitions<TDefinition extends DiscoveredDefinition>(
  feature: string,
  source: SuffixDefinitionCatalogSource<TDefinition>,
): TDefinition[] {
  const definitions = new Map<string, TDefinition>()

  for (const root of source.roots) {
    for (const file of listMatchingFiles(root, name => source.pattern.test(name), { includeHidden: source.includeHidden })) {
      const name = source.normalizeName(root, file)
      if (!name) {
        continue
      }

      registerDefinition(definitions, createDefinition(source, file, name), feature)
    }
  }

  return sortDefinitions(definitions)
}

function scanDirectoryDefinitions<TDefinition extends DiscoveredDefinition>(
  feature: string,
  source: DirectoryDefinitionCatalogSource<TDefinition>,
): TDefinition[] {
  const definitions = new Map<string, TDefinition>()

  for (const scanDir of source.scanDirs) {
    const directory = resolve(scanDir, source.subdir)
    for (const file of listSourceFiles(directory, { includeHidden: source.includeHidden })) {
      const name = source.normalizeName
        ? source.normalizeName(directory, file)
        : normalizePathDefinitionName(directory, file)
      if (!name) {
        continue
      }

      registerDefinition(definitions, createDefinition(source, file, name), feature)
    }
  }

  return sortDefinitions(definitions)
}

export function discoverDefinitions<TDefinition extends DiscoveredDefinition>(
  feature: string,
  sources: DefinitionCatalogSource<TDefinition>[],
): TDefinition[] {
  return mergeDefinitions(
    feature,
    ...sources.map(source => source.kind === "suffix" ? scanSuffixDefinitions(feature, source) : scanDirectoryDefinitions(feature, source)),
  )
}

function createImportExpression(registryFile: string, file: string): string {
  const importPath = relative(resolve(registryFile, ".."), file)
  return `import(${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)})`
}

export function createRuntimeRegistryContents(registryFile: string, definitions: Array<Pick<DiscoveredDefinition, "handler" | "name">>): string {
  return [
    "",
    "const registry = {",
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: async () => ${createImportExpression(registryFile, definition.handler)},`),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

export async function writeRuntimeRegistryFile<TDefinition extends Pick<DiscoveredDefinition, "handler" | "name">>(
  registryFile: string,
  definitions: TDefinition[],
): Promise<void> {
  await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions))
}

export function createGeneratedDefinitionPath(
  rootDir: string,
  options: {
    buildDir?: string
    fileName: string
    productName?: string
    segments?: readonly string[]
  },
): string {
  const segments = options.segments ?? generatedDirSegments(options.productName!)
  const pathSegments = options.buildDir
    ? [rootDir, options.buildDir, ...segments, options.fileName]
    : [rootDir, ...segments, options.fileName]
  return resolve(...pathSegments)
}

export interface RuntimeRegistryFiles<TDefinition extends Pick<DiscoveredDefinition, "handler" | "name">> {
  definitions: TDefinition[]
  pluginFile: string
  registryFile: string
}

export async function writeRuntimeRegistryFiles<TDefinition extends Pick<DiscoveredDefinition, "handler" | "name">>(
  options: {
    createPluginContents: (pluginFile: string, registryFile: string) => string
    definitions: TDefinition[]
    pluginFile: string
    registryFile: string
  },
): Promise<RuntimeRegistryFiles<TDefinition>> {
  await Promise.all([
    writeRuntimeRegistryFile(options.registryFile, options.definitions),
    writeFileIfChanged(options.pluginFile, options.createPluginContents(options.pluginFile, options.registryFile)),
  ])

  return {
    definitions: options.definitions,
    pluginFile: options.pluginFile,
    registryFile: options.registryFile,
  }
}

export async function writeFileIfChanged(file: string, contents: string): Promise<void> {
  const existing = await readFile(file, "utf8").catch(() => undefined)
  if (existing === contents) {
    return
  }

  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}
