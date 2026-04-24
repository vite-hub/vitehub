import { existsSync, readdirSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

const sourceFilePattern = /\.(?:c|m)?[jt]s$/i
const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
const ignoredDirs = new Set(["node_modules", "dist", ".nitro", ".output", ".nuxt", ".vercel", ".git", ".vitehub"])

export interface DiscoveredDefinition {
  handler: string
  name: string
  source?: string
}

export function listMatchingFiles(root: string, predicate: (name: string) => boolean): string[] {
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

export function listSourceFiles(root: string): string[] {
  return listMatchingFiles(root, name => sourceFilePattern.test(name) && !declarationFilePattern.test(name))
}

export function normalizePathDefinitionName(rootDir: string, file: string): string {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  return relativePath.replace(sourceFilePattern, "").replace(/\/index$/i, "")
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

export function createRuntimeRegistryContents(registryFile: string, definitions: Array<Pick<DiscoveredDefinition, "handler" | "name">>): string {
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

export async function writeFileIfChanged(file: string, contents: string): Promise<void> {
  const existing = await readFile(file, "utf8").catch(() => undefined)
  if (existing === contents) {
    return
  }

  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}
