import { existsSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i
const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const ignoredDirs = new Set(["node_modules", "dist", ".nitro", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])

function listMatchingFiles(root: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(root)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
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

function listQueueFiles(root: string): string[] {
  return listMatchingFiles(root, name => queueSuffixPattern.test(name))
}

function listSourceFiles(root: string): string[] {
  return listMatchingFiles(root, name => sourceFilePattern.test(name) && !declarationFilePattern.test(name))
}

function normalizeSuffixQueueName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  const normalized = relativePath.replace(queueSuffixPattern, "")
  return normalized.startsWith("src/") ? normalized.slice("src/".length) : normalized
}

function normalizeNitroQueueName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  const normalized = relativePath.replace(sourceFilePattern, "").replace(/\/index$/i, "")
  return normalized
}

export function scanSuffixQueueFiles(rootDir: string): DiscoveredQueueDefinition[] {
  const files = listQueueFiles(rootDir)
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const file of files) {
    const name = normalizeSuffixQueueName(rootDir, file)
    if (!name) {
      continue
    }

    const existing = definitions.get(name)
    if (existing) {
      throw new Error(`Duplicate queue name "${name}" from suffix scan:\n  - ${existing.handler}\n  - ${file}`)
    }

    definitions.set(name, { handler: file, name, source: "vite-suffix" })
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function scanNitroQueueFiles(scanDirs: string[]): DiscoveredQueueDefinition[] {
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const scanDir of scanDirs) {
    const queueDir = resolve(scanDir, "queues")
    for (const file of listSourceFiles(queueDir)) {
      const name = normalizeNitroQueueName(queueDir, file)
      if (!name) {
        continue
      }

      const existing = definitions.get(name)
      if (existing) {
        throw new Error(`Duplicate queue name "${name}" from Nitro server/queues scan:\n  - ${existing.handler}\n  - ${file}`)
      }

      definitions.set(name, {
        handler: file,
        name,
        source: "nitro-server-queues",
      })
    }
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function mergeQueueDefinitions(...sources: Array<DiscoveredQueueDefinition[] | undefined>): DiscoveredQueueDefinition[] {
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const source of sources) {
    if (!source) {
      continue
    }

    for (const definition of source) {
      const existing = definitions.get(definition.name)
      if (existing && existing.handler !== definition.handler) {
        throw new Error(`Duplicate queue name "${definition.name}" from multiple discovery sources:\n  - ${existing.handler} (${existing.source ?? "unknown"})\n  - ${definition.handler} (${definition.source ?? "unknown"})`)
      }

      if (!existing) {
        definitions.set(definition.name, definition)
      }
    }
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function discoverQueueDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-queues", scanDirs: string[] }
): DiscoveredQueueDefinition[] {
  if (options.mode === "nitro-server-queues") {
    return scanNitroQueueFiles(options.scanDirs)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return mergeQueueDefinitions(...[...roots].map(root => scanSuffixQueueFiles(root)))
}

export function createQueueRegistryContents(registryFile: string, definitions: DiscoveredQueueDefinition[]) {
  const imports = definitions.map((definition) => {
    const importPath = relative(resolve(registryFile, ".."), definition.handler).replace(/\\/g, "/")
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
