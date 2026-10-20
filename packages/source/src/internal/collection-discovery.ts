import { readFile, readdir } from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"

import { argumentExpression, findCalls, findProperty, scanModule, staticValue } from "@vite-hub/internal/build/scan-module"
import { findExportNames } from "mlly"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

import type { CallExpression, ScannedModule } from "@vite-hub/internal/build/scan-module"

export interface CollectionDiscoveryOptions {
  projectRoot: string
  serverDirs?: string[]
}

export interface DiscoveredCollection {
  /** The exported `defineCollection(...)` call, when it can be found without running the module. */
  definition?: CallExpression
  exportName: string
  file: string
  name: string
  route: boolean
}

/** The initializers of top-level `const`, `let`, and `var` declarations named `name`. */
function declarationInitializers(module: ScannedModule, name: string, exportedOnly: boolean) {
  return module.program.body.flatMap((statement) => {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : exportedOnly ? undefined : statement
    if (declaration?.type !== "VariableDeclaration") return []
    return declaration.declarations.flatMap(declarator => declarator.id.type === "Identifier" && declarator.id.name === name && declarator.init ? [declarator.init] : [])
  })
}

/** The local binding that `export { local as exportName }` exports, without a module source. */
function exportedLocalName(module: ScannedModule, exportName: string): string | undefined {
  for (const statement of module.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source || statement.exportKind === "type") continue
    for (const specifier of statement.specifiers) {
      const exported = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      if (exported === exportName && specifier.local.type === "Identifier") return specifier.local.name
    }
  }
}

/**
 * Finds the `defineCollection(...)` call that initializes the named export. An initializer with more than one call,
 * such as a conditional, has no known call: the scanner cannot know which branch runs.
 */
function findCollectionDefinitionCall(source: string, exportName: string, file: string): CallExpression | undefined {
  const module = scanModule(source, file)
  const calls = findCalls(module, ["defineCollection"])
  const callIn = (initializer: { end: number, start: number }) => {
    const matches = calls.filter(call => call.start >= initializer.start && call.end <= initializer.end)
    return matches.length === 1 ? matches[0] : undefined
  }
  for (const initializer of declarationInitializers(module, exportName, true)) {
    const call = callIn(initializer)
    if (call) return call
  }
  // Named exports may also re-export a local binding (`export { articles }`). Resolve that binding so route metadata
  // stays attached to the Collection that discovery imports.
  const localName = exportedLocalName(module, exportName)
  if (localName === undefined) return
  for (const initializer of declarationInitializers(module, localName, false)) {
    const call = callIn(initializer)
    if (call) return call
  }
}

function collectionRouteDisabled(call: CallExpression | undefined): boolean {
  if (!call) return false
  const options = argumentExpression(call.arguments[1] ?? call.arguments[0])
  const route = options?.type === "ObjectExpression" ? findProperty(options, "route")?.value : undefined
  return route !== undefined && staticValue(route) === false
}

export async function collectCollectionFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectCollectionFiles(path))
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path)
  }
  return files
}

/** Lists Collection modules under `<serverDir>/collections`. It reads the files and does not import them. */
export async function discoverCollections(options: CollectionDiscoveryOptions): Promise<DiscoveredCollection[]> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const collections = (await Promise.all(serverDirs.map(async (serverDir) => {
    const directory = resolve(serverDir, "collections")
    return await Promise.all((await collectCollectionFiles(directory)).sort().map(async (file) => {
      const extension = extname(file)
      const exportName = basename(file, extension)
      if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
        throw sourceErrorDiagnostics.SOURCE_B0003({ message: `[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must use a valid JavaScript identifier as its filename.` })
      }
      const name = relative(directory, file).slice(0, -extension.length).replaceAll("\\", "/")
      const source = await readFile(file, "utf8")
      if (!findExportNames(source).includes(exportName)) {
        throw sourceErrorDiagnostics.SOURCE_B0004({ message: `[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.` })
      }
      const definition = findCollectionDefinitionCall(source, exportName, file)
      return { definition, exportName, file, name, route: !collectionRouteDisabled(definition) }
    }))
  }))).flat().sort((left, right) => left.name.localeCompare(right.name))

  const generatedPaths = new Map<string, DiscoveredCollection>()
  for (const collection of collections) {
    const generatedPath = `${collection.name}.mjs`.toLowerCase()
    const previous = generatedPaths.get(generatedPath)
    if (previous?.name === collection.name) {
      throw sourceErrorDiagnostics.SOURCE_B0005({ message: `[vitehub] Collection name ${JSON.stringify(collection.name)} is defined in more than one server directory.` })
    }
    if (previous) {
      const [firstName, secondName] = [previous.name, collection.name].sort()
      throw sourceErrorDiagnostics.SOURCE_B0006({ message: `[vitehub] Collection names ${JSON.stringify(firstName)} and ${JSON.stringify(secondName)} generate the same route module on case-insensitive filesystems.` })
    }
    generatedPaths.set(generatedPath, collection)
  }
  return collections
}
