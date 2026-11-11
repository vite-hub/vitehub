import { readFile, readdir } from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"

import { argumentExpression, exportNames, findCalls, objectProperties, scanModule, staticValue, unwrapExpression } from "@vite-hub/internal/build/scan-module"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

import type { CallExpression, Expression, Node, ScannedModule } from "@vite-hub/internal/build/scan-module"

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

/** The initializers of top-level `const`, `let`, and `var` declarations named `name`, with their declaration kind. */
function declarationInitializers(module: ScannedModule, name: string, exportedOnly: boolean) {
  return module.program.body.flatMap((statement) => {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : exportedOnly ? undefined : statement
    if (declaration?.type !== "VariableDeclaration") return []
    return declaration.declarations.flatMap(declarator => declarator.id.type === "Identifier" && declarator.id.name === name && declarator.init
      ? [{ init: declarator.init, constant: declaration.kind === "const" }]
      : [])
  })
}

const viteHubSourceSpecifier = /^(?:@vite-hub\/source|vite-hub\/source)(?:\/|$)/

/** Checks binding targets, including nested destructuring, without treating property keys or defaults as bindings. */
function bindsCollectionFactory(binding: Node): boolean {
  switch (binding.type) {
    case "Identifier": return binding.name === "defineCollection"
    case "ObjectPattern": return binding.properties.some(property => bindsCollectionFactory(property.type === "RestElement" ? property.argument : property.value))
    case "ArrayPattern": return binding.elements.some(element => element !== null && bindsCollectionFactory(element))
    case "AssignmentPattern": return bindsCollectionFactory(binding.left)
    case "RestElement": return bindsCollectionFactory(binding.argument)
    default: return false
  }
}

/**
 * True when `defineCollection` in this module is ViteHub's factory: imported from a ViteHub Source entry, or not
 * declared in the module at all (an auto-import). A local function or an import from elsewhere with that name can
 * return any Collection, so its options say nothing about the route.
 */
function callsViteHubFactory(module: ScannedModule): boolean {
  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration") {
      const local = statement.specifiers.some(specifier => specifier.local.name === "defineCollection")
      if (local) return statement.importKind !== "type" && viteHubSourceSpecifier.test(statement.source.value)
      continue
    }
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id?.name === "defineCollection") return false
    if (declaration?.type === "VariableDeclaration" && declaration.declarations.some(declarator => bindsCollectionFactory(declarator.id))) return false
  }
  return true
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
function findCollectionDefinitionCall(source: string, exportName: string, file: string): CollectionDefinitionCall | undefined {
  // Collection files may use TypeScript syntax whatever their extension, such as a `.mjs` file from generated types.
  const module = scanModule(source, `${file}.ts`)
  const calls = findCalls(module, ["defineCollection"])
  const factory = callsViteHubFactory(module)
  const callIn = ({ init, constant }: { init: Expression, constant: boolean }) => {
    const matches = calls.filter(call => call.start >= init.start && call.end <= init.end)
    const [call] = matches
    // Only a `const` keeps its initializer: a later `var` declaration or an assignment can export another value.
    return matches.length === 1 && call ? { call, exported: factory && constant && unwrapExpression(init) === call } : undefined
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

interface CollectionDefinitionCall {
  call: CallExpression
  /** True when the export is the value that ViteHub's `defineCollection()` returns from this call. */
  exported: boolean
}

/**
 * True only for a literal `route: false` in the options of the exported `defineCollection()` call. A spread or a
 * computed key after it can set `route` again when the module runs, so the route stays. Any other form keeps the route,
 * and `defineCollectionHandler()` answers 404 at request time when the Collection has `route: false`.
 */
function collectionRouteDisabled(definition: CollectionDefinitionCall | undefined): boolean {
  if (!definition?.exported) return false
  const options = argumentExpression(definition.call.arguments[1] ?? definition.call.arguments[0])
  if (options?.type !== "ObjectExpression") return false
  const properties = objectProperties(options)
  const index = properties.findLastIndex(property => property.key === "route")
  const route = properties[index]?.value
  return route !== undefined && staticValue(route) === false && properties.slice(index + 1).every(property => property.key !== undefined)
}

/** Whether the module exports `exportName`, and whether that Collection gets a generated route. */
export function inspectCollectionSource(file: string, source: string, exportName: string): { exported: boolean, routeEnabled: boolean } {
  const exported = exportNames(source, `${file}.ts`).includes(exportName)
  return { exported, routeEnabled: exported && !collectionRouteDisabled(findCollectionDefinitionCall(source, exportName, file)) }
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
      if (!exportNames(source, `${file}.ts`).includes(exportName)) {
        throw sourceErrorDiagnostics.SOURCE_B0004({ message: `[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.` })
      }
      const definition = findCollectionDefinitionCall(source, exportName, file)
      return { definition: definition?.call, exportName, file, name, route: !collectionRouteDisabled(definition) }
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
