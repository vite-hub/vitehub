import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { basename, relative, resolve } from "node:path"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i
const ignoredDirs = new Set(["node_modules", "dist", ".nitro", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])

function listQueueFiles(root: string): string[] {
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
      files.push(...listQueueFiles(absolute))
      continue
    }

    if (entry.isFile() && queueSuffixPattern.test(entry.name)) {
      files.push(absolute)
    }
  }

  return files.sort()
}

function normalizeSuffixQueueName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  return relativePath.replace(queueSuffixPattern, "")
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

    definitions.set(name, {
      handler: file,
      name,
      source: "vite-suffix",
    })
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function discoverQueueDefinitions(options: { rootDir: string, scanDirs?: string[] }): DiscoveredQueueDefinition[] {
  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return mergeQueueDefinitions(...[...roots].map(root => scanSuffixQueueFiles(root)))
}

export function mergeQueueDefinitions(...sources: Array<DiscoveredQueueDefinition[] | undefined>): DiscoveredQueueDefinition[] {
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

function manifestPath(rootDir: string) {
  return resolve(rootDir, "node_modules", ".vitehub", "queue", "manifest.json")
}

export function readQueueManifest(rootDir: string): { definitions: DiscoveredQueueDefinition[], generatedAt: string, rootDir: string, version: 1 } | undefined {
  const file = manifestPath(rootDir)
  if (!existsSync(file)) {
    return undefined
  }

  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || !Array.isArray(parsed.definitions)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export function writeQueueManifest(rootDir: string, definitions: DiscoveredQueueDefinition[]) {
  const file = manifestPath(rootDir)
  mkdirSync(resolve(file, ".."), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const manifest = {
    definitions,
    generatedAt: new Date().toISOString(),
    rootDir,
    version: 1 as const,
  }
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  renameSync(temp, file)
  return file
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

export function getQueueBaseName(name: string) {
  return basename(name)
}
