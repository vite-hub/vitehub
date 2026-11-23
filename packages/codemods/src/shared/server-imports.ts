import { readFile } from "node:fs/promises"
import { basename, dirname, extname, join, posix } from "node:path"

import { end, findProperty, isReference, keyName, parseProgram, quoteString, walk } from "@vite-hub/internal/ast"
import { viteHubServerImportSources } from "@vite-hub/internal/nuxt-server-imports"
import { glob } from "tinyglobby"

import { bindingResolver } from "./binding-resolver.ts"
import { localLayerDirectories } from "./layers.ts"
import { literalValue, objectProperty, unwrapExpression } from "./nuxt-config.ts"

import type { File, ImportDeclaration } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type MagicString from "magic-string"
import type { NuxtConfigFile } from "./nuxt-config.ts"

export { viteHubServerImportSources }

const valueReadingTypeParents = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSTypeQuery", "TSExportAssignment", "TSInstantiationExpression"])

/**
 * The names of `candidates` that the program reads without a binding in scope, each with the first node that reads it.
 * Type positions, such as a type named `schema`, do not count.
 */
export function freeReferences(program: File, candidates: ReadonlySet<string>): Map<string, Node> {
  const resolve = bindingResolver(program)
  const found = new Map<string, Node>()
  walk(program, (node, ancestors) => {
    if (node.type !== "Identifier" || !candidates.has(node.name) || found.has(node.name)) return
    const parent = ancestors.at(-1)
    if (!parent || !isReference(node, parent)) return
    if (parent.type.startsWith("TS") && !valueReadingTypeParents.has(parent.type)) return
    if (parent.type === "ExportSpecifier" && ancestors.at(-2)?.type === "ExportNamedDeclaration" && (ancestors.at(-2) as { source?: unknown }).source) return
    if (resolve(node)) return
    found.set(node.name, node)
  })
  return found
}

export interface AddedImport {
  name: string
  from: string
}

export interface ServerImportInput {
  /** The code of the script block that `program` parsed. */
  code: string
  program: File
  output: MagicString
  /** Offset of the block in `output`. */
  offset?: number
  style: CodeStyle
  /** Names that the app's own auto-imports give, such as an export of `server/utils/db.ts`. */
  skip: ReadonlySet<string>
  /** The helper names to import. Defaults to every ViteHub server helper. */
  names?: ReadonlySet<string>
}

/**
 * Adds an import from its `vite-hub/*` entry for each ViteHub server helper that the block reads without a binding.
 * It joins the names with a named value import of the same entry when the block has one, and else adds one import
 * line per entry after the last import. Returns the names that it imported and the skipped names that the block reads.
 */
export function addServerImports(input: ServerImportInput): { added: AddedImport[], skipped: string[] } {
  const { code, program, output, offset = 0, style, skip } = input
  const candidates = new Set([...(input.names ?? viteHubServerImportSources.keys())].filter(name => viteHubServerImportSources.has(name)))
  const free = freeReferences(program, candidates)
  const skipped = [...free.keys()].filter(name => skip.has(name)).sort()
  const byEntry = new Map<string, string[]>()
  for (const name of [...free.keys()].sort()) {
    if (skip.has(name)) continue
    const from = viteHubServerImportSources.get(name)!
    byEntry.set(from, [...(byEntry.get(from) ?? []), name])
  }
  const added: AddedImport[] = []
  const imports = program.program.body.filter(statement => statement.type === "ImportDeclaration")
  const lines: string[] = []
  for (const [from, names] of [...byEntry].sort(([left], [right]) => left.localeCompare(right))) {
    added.push(...names.map(name => ({ name, from })))
    const target = imports.find(statement => statement.source.value === from && isNamedValueImport(statement))
    const last = target?.specifiers.at(-1)
    if (last) {
      output.appendLeft(offset + end(last), `, ${names.join(", ")}`)
      continue
    }
    lines.push(`import { ${names.join(", ")} } from ${quoteString(from, style)}${style.semicolons ? ";" : ""}`)
  }
  if (lines.length) {
    const last = imports.at(-1)
    if (last) output.appendLeft(offset + end(last), lines.map(line => `\n${line}`).join(""))
    else output.prependLeft(offset + offsetAfterShebang(code), `${lines.join("\n")}\n${program.program.body.length ? "\n" : ""}`)
  }
  return { added, skipped }
}

function isNamedValueImport(statement: ImportDeclaration): boolean {
  return statement.importKind !== "type" && statement.specifiers.some(specifier => specifier.type === "ImportSpecifier")
    && !statement.specifiers.some(specifier => specifier.type === "ImportNamespaceSpecifier")
}

function offsetAfterShebang(code: string): number {
  return code.startsWith("#!") ? code.indexOf("\n") + 1 : 0
}

const sourceFile = /\.[cm]?[jt]sx?$/
const declarationFile = /\.d\.[cm]?ts$/

/**
 * The names that the app's own server auto-imports give, mapped to where each comes from: the exports of files
 * directly in `server/utils/` and `shared/utils/` of the app and its local layers, as Nuxt 5 scans them, and the
 * `nitro.imports.imports` entries of nuxt.config.
 */
export async function appServerImportNames(cwd: string, config: NuxtConfigFile): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const layer of await localLayerDirectories(cwd, config)) {
    for (const dir of [posix.join(serverDirectory(config, layer), "utils"), posix.join(layer, "shared/utils")]) {
      for (const file of (await glob([`${dir}/*`], { cwd, onlyFiles: true })).sort()) {
        if (!sourceFile.test(file) || declarationFile.test(file)) continue
        for (const name of await exportNames(join(cwd, file), file)) if (!names.has(name)) names.set(name, file)
      }
    }
  }
  const nitro = objectProperty(config.root, "nitro")
  const nitroImports = nitro ? objectProperty(nitro, "imports") : undefined
  const entries = nitroImports ? findProperty(nitroImports, "imports") : undefined
  const list = entries ? unwrapExpression(entries.value) : undefined
  if (list?.type === "ArrayExpression") {
    for (const element of list.elements) {
      const entry = element ? unwrapExpression(element) : undefined
      if (entry?.type !== "ObjectExpression") continue
      const as = findProperty(entry, "as")
      const name = findProperty(entry, "name")
      const value = as ? literalValue(as.value) : name ? literalValue(name.value) : undefined
      if (typeof value === "string" && !names.has(value)) names.set(value, `${config.fileName} nitro.imports.imports`)
    }
  }
  return names
}

/** The server directory of a layer: `serverDir` of nuxt.config for the app, and `server/` otherwise. */
export function serverDirectory(config: NuxtConfigFile, layer: string): string {
  const property = layer === "." ? findProperty(config.root, "serverDir") : undefined
  const value = property ? literalValue(property.value) : undefined
  const dir = typeof value === "string" ? value.replace(/^\.\//, "").replace(/\/$/, "") : "server"
  return posix.normalize(posix.join(layer, dir))
}

async function exportNames(path: string, file: string): Promise<string[]> {
  let program: File
  try {
    program = parseProgram(await readFile(path, "utf8"), { jsx: file.endsWith("x"), typescript: /\.[cm]?tsx?$/.test(file) })
  }
  catch {
    return []
  }
  const names: string[] = []
  for (const statement of program.program.body) {
    if (statement.type === "ExportDefaultDeclaration") names.push(defaultExportName(file))
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    const declaration = statement.declaration
    if ((declaration?.type === "FunctionDeclaration" || declaration?.type === "ClassDeclaration") && declaration.id) names.push(declaration.id.name)
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) if (declarator.id.type === "Identifier") names.push(declarator.id.name)
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue
      const name = keyName(specifier.exported)
      if (name) names.push(name === "default" ? defaultExportName(file) : name)
    }
  }
  return names
}

function defaultExportName(file: string): string {
  const name = basename(file, extname(file))
  return (name === "index" ? basename(dirname(file)) : name).replace(/[-_.\s]+(\w)/g, (_, letter: string) => letter.toUpperCase())
}
