import { readFile, readdir } from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"

import { createSourceScanner } from "@vite-hub/internal/source-scanner"
import { findExportNames } from "mlly"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

import type { IdentifierCall } from "@vite-hub/internal/source-scanner"

export interface CollectionDiscoveryOptions {
  projectRoot: string
  serverDirs?: string[]
}

export interface DiscoveredCollection {
  /** The exported `defineCollection(...)` call, when it can be found without running the module. */
  definition?: IdentifierCall
  exportName: string
  file: string
  name: string
  route: boolean
}

/** Finds the `defineCollection(...)` call that initializes the named export. */
function findCollectionDefinitionCall(source: string, exportName: string, file: string): IdentifierCall | undefined {
  const scanner = createSourceScanner(file)
  const masked = scanner.maskSourceLiterals(source)
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const identifier = String.raw`[$\p{ID_Start}_][$\p{ID_Continue}]*`
  // Bind the call to the exported declaration itself. Looking only at the
  // prefix up to a call can accidentally select an earlier local declaration
  // with the same name, so first locate the exported initializer and then
  // inspect calls inside that initializer.
  const declaration = new RegExp(`(?:^|[;\\n])\\s*export\\s+(?:const|let|var)\\s+${escapedExportName}(?:\\s*:\\s*[^=;]+)?\\s*=`, "g")
  const calls = scanner.findIdentifierCalls(source, "defineCollection")
  let call
  const findDeclarationCall = (initializerStart: number) => {
    // Scan only this initializer. Matched groups retain nested calls and
    // semicolons inside IIFEs, while top-level separators end the binding.
    let end = initializerStart
    let previous = ""
    for (; end < masked.length; end++) {
      const char = masked[end]!
      if (char === ";" || char === ",") break
      if (char === "\n" && previous) {
        const next = masked.slice(end).trimStart()
        // A newline can continue an expression after an operator or before
        // a member access/call/operator; otherwise automatic semicolon
        // insertion ends the initializer before the next statement.
        if (!/[=?:+\-*/%&|^!<>.]/.test(previous)
          && !/^(?:[.([?+\-*/%&|^<>=]|as\b|satisfies\b)/.test(next)) break
      }
      const close = char === "(" ? ")" : char === "[" ? "]" : char === "{" ? "}" : undefined
      if (close) {
        const matched = scanner.findMatching(source, end, char, close)
        if (matched === undefined) return undefined
        end = matched
        previous = close
      }
      else if (!/\s/.test(char)) previous = char
    }
    const matches = calls.filter(candidate => candidate.start >= initializerStart && candidate.closeParen < end)
    // A conditional (or other expression) can contain more than one
    // defineCollection call. Without evaluating user code we cannot know
    // which branch initializes the export, so avoid reporting metadata from
    // an arbitrary branch.
    return matches.length === 1 ? matches[0] : undefined
  }
  for (const match of masked.matchAll(declaration)) {
    const initializerStart = (match.index ?? 0) + match[0].length
    call = findDeclarationCall(initializerStart)
    if (call) break
  }
  // Named exports may also re-export a local binding (`export { articles }`).
  // Resolve that binding before inspecting its initializer so route metadata
  // stays attached to the Collection that discovery imports.
  if (!call) {
    const exportList = new RegExp(`\\bexport\\s*\\{([^}]*)\\}`, "g")
    for (const match of masked.matchAll(exportList)) {
      const localName = match[1]
        .split(",")
        .map(entry => entry.trim().match(new RegExp(`^(${identifier})\\s+as\\s+${escapedExportName}$|^${escapedExportName}$`, "u")))
        .find(Boolean)?.[1] ?? (match[1].split(",").map(entry => entry.trim()).find(entry => entry === exportName) ? exportName : undefined)
      if (!localName) continue
      // The export list may appear before or after the local declaration. Include
      // `export const` declarations as well, then bind the name to its own
      // initializer rather than relying on statement order.
      const escapedLocalName = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const localDeclaration = new RegExp(`(?:^|[;\\n])\\s*(?:export\\s+)?(?:const|let|var)\\s+${escapedLocalName}(?:\\s*:\\s*[^=;]+)?\\s*=`, "g")
      for (const declarationMatch of masked.matchAll(localDeclaration)) {
        const initializerStart = (declarationMatch.index ?? 0) + declarationMatch[0].length
        const candidateCall = findDeclarationCall(initializerStart)
        if (candidateCall) {
          call = candidateCall
          break
        }
      }
      if (call) break
    }
  }
  return call
}

function collectionRouteDisabled(call: IdentifierCall | undefined, file: string): boolean {
  if (!call) return false
  const options = call.arguments[1] ?? call.arguments[0]
  return options !== undefined && createSourceScanner(file).readObjectProperty(options, "route") === "false"
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
      return { definition, exportName, file, name, route: !collectionRouteDisabled(definition, file) }
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
