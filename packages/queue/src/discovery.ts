import { existsSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?ts$/i

function listQueueFiles(root: string): string[] {
  if (!existsSync(root)) return []

  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...listQueueFiles(absolute))
    }
    else if (entry.isFile() && queueFilePattern.test(entry.name) && !declarationFilePattern.test(entry.name)) {
      files.push(absolute)
    }
  }
  return files.sort()
}

function normalizeQueueName(queuesRoot: string, file: string): string {
  return relative(queuesRoot, file)
    .replace(/\\/g, "/")
    .replace(queueFilePattern, "")
    .replace(/\/index$/i, "")
}

export function discoverQueueDefinitions(options: {
  rootDir?: string
  scanDirs?: string[]
  srcDir?: string
}): DiscoveredQueueDefinition[] {
  const roots = new Set([
    options.rootDir,
    options.srcDir,
    ...(options.scanDirs || []),
  ].filter((item): item is string => Boolean(item)))
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const root of roots) {
    const queuesRoot = resolve(root, "server", "queues")
    for (const file of listQueueFiles(queuesRoot)) {
      const name = normalizeQueueName(queuesRoot, file)
      if (!name) continue

      const existing = definitions.get(name)
      if (existing) {
        throw new TypeError(`Duplicate queue definition \`${name}\` discovered in \`${existing.handler}\` and \`${file}\`.`)
      }

      definitions.set(name, { handler: file, name })
    }
  }

  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function createQueueRegistryContents(
  registryFile: string,
  definitions: DiscoveredQueueDefinition[],
): string {
  const imports = definitions.map((definition) => {
    const relativePath = relative(resolve(registryFile, ".."), definition.handler).replace(/\\/g, "/")
    const importPath = relativePath.startsWith(".") ? relativePath : `./${relativePath}`
    return `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(importPath)}),`
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
