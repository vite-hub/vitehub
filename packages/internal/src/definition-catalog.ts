import type { Dirent } from "node:fs"
import { readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"

import { relative, resolve } from "pathe"

import { generatedDirSegments } from "./build/paths.ts"

const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const ignoredDirs = new Set(["node_modules", "dist", ".nitro", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])

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
  kind: "suffix"
  normalizeName: (rootDir: string, file: string) => string | undefined
  pattern: RegExp
  roots: string[]
}

export interface DirectoryDefinitionCatalogSource<TDefinition extends DiscoveredDefinition> extends BaseDefinitionCatalogSource<TDefinition> {
  kind: "directory"
  normalizeName?: (directory: string, file: string) => string | undefined
  scanDirs: string[]
  subdir: string
}

export type DefinitionCatalogSource<TDefinition extends DiscoveredDefinition> =
  | DirectoryDefinitionCatalogSource<TDefinition>
  | SuffixDefinitionCatalogSource<TDefinition>

function readDirEntries(root: string): Dirent[] {
  try {
    return readdirSync(root, { withFileTypes: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
}

export function listMatchingFiles(root: string, predicate: (name: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of readDirEntries(root)) {
    if (entry.name.startsWith(".")) {
      continue
    }

    const absolute = resolve(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (ignoredDirs.has(entry.name)) {
        continue
      }
      files.push(...listMatchingFiles(absolute, predicate))
      continue
    }

    if (entry.isFile() && predicate(entry.name)) {
      files.push(absolute)
    }
  }

  return files.sort()
}

export function listSourceFiles(root: string): string[] {
  return listMatchingFiles(root, name => sourceFilePattern.test(name) && !declarationFilePattern.test(name))
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
    for (const file of listMatchingFiles(root, name => source.pattern.test(name))) {
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
    for (const file of listSourceFiles(directory)) {
      const name = source.normalizeName?.(directory, file) ?? normalizePathDefinitionName(directory, file)
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

export function createRuntimeRegistryContents(registryFile: string, definitions: Array<Pick<DiscoveredDefinition, "handler" | "name">>): string {
  const imports = definitions.map((definition) => {
    const importPath = relative(resolve(registryFile, ".."), definition.handler)
    return `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)}),`
  })

  return [
    "const registry = {",
    ...imports,
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
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

export async function writeFileIfChanged(file: string, contents: string): Promise<void> {
  const existing = await readFile(file, "utf8").catch(() => undefined)
  if (existing === contents) {
    return
  }

  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}
