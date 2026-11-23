import { readFile } from "node:fs/promises"
import { basename, dirname, extname, join, posix, relative, resolve } from "node:path"

import { end, isReference, keyName, parseProgram, quoteString, walk } from "@vite-hub/internal/ast"
import { viteHubServerImportSources } from "@vite-hub/internal/nuxt-server-imports"
import { glob } from "tinyglobby"

import { bindingResolver } from "./binding-resolver.ts"
import { unwrapExpression } from "./nuxt-config.ts"
import { setting, unknownSetting } from "./nuxt-server-layout.ts"

import type { File, ImportDeclaration } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type MagicString from "magic-string"
import type { NuxtServerLayout } from "./nuxt-server-layout.ts"

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
    if (parent.type === "ExportNamespaceSpecifier" || parent.type === "ExportDefaultSpecifier") return
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

export async function appServerImports(cwd: string, layout: NuxtServerLayout) {
  const names = new Map<string, string>()
  const unknown = new Set<string>()
  if (layout.injection === false) return { names, unknown }
  for (const source of layout.unknownLayers) unknown.add(source)
  const add = (name: string, from: string) => {
    if (!names.has(name)) names.set(name, from)
  }
  const scan = async (directory: string) => {
    const pattern = /[*?[{]/.test(directory) ? directory : `${directory}/*`
    for (const file of (await glob(pattern, { cwd, onlyFiles: true })).sort()) {
      if (!sourceFile.test(file) || declarationFile.test(file)) continue
      const exports = await exportNames(cwd, file, unknown)
      for (const name of exports) add(name === "default" ? defaultExportName(file) : name, file)
    }
  }
  const scanSetting = layout.effective("imports", "scan")
  if (scanSetting === unknownSetting || (scanSetting !== undefined && scanSetting.type !== "BooleanLiteral")) unknown.add("imports.scan")
  const legacy = layout.effective("nitroLegacy")
  const legacyImports = layout.effective("nitroLegacy", "imports")
  const nested = legacy !== unknownSetting && (legacy?.type === "BooleanLiteral" && legacy.value
    || legacy?.type === "ObjectExpression" && (legacyImports === undefined || (legacyImports !== unknownSetting && legacyImports.type === "BooleanLiteral" && legacyImports.value)))
  if (scanSetting === undefined || (scanSetting !== unknownSetting && scanSetting.type === "BooleanLiteral" && scanSetting.value)) {
    for (const layer of layout.layers) {
      const layerScan = setting(layer.config?.root, "imports", "scan")
      if (layerScan !== undefined && (layerScan === unknownSetting || layerScan.type !== "BooleanLiteral")) unknown.add(`${layer.config?.path ?? layer.directory} imports.scan`)
      if (layerScan !== unknownSetting && layerScan?.type === "BooleanLiteral" && !layerScan.value) continue
      if (layer.server) {
        await scan(posix.join(layer.server, nested ? "utils/**/*" : "utils"))
        await scan(posix.join(layer.server, "types"))
      }
      else unknown.add(`${layer.config?.path ?? layer.directory} serverDir`)
      if (layer.shared) {
        await scan(posix.join(layer.shared, "utils"))
        await scan(posix.join(layer.shared, "types"))
      }
      else unknown.add(`${layer.config?.path ?? layer.directory} dir.shared`)
    }
  }
  for (const layer of layout.layers) {
    for (const key of ["dirs", "imports", "presets"] as const) {
      const list = setting(layer.config?.root, "nitro", "imports", key)
      if (list === undefined) continue
      const from = `${posix.join(layer.directory, layer.config?.fileName ?? "nuxt.config")} nitro.imports.${key}`
      if (list === unknownSetting || list.type !== "ArrayExpression") {
        unknown.add(from)
        continue
      }
      for (const element of list.elements) {
        if (!element) continue
        const entry = unwrapExpression(element)
        if (key === "dirs" && entry.type === "StringLiteral" && !/^[@~#]/.test(entry.value)) {
          await scan(relative(cwd, resolve(cwd, entry.value)).replaceAll("\\", "/") || ".")
        }
        else if (key === "imports" && entry.type === "ObjectExpression") {
          const name = setting(entry, "as") ?? setting(entry, "name")
          if (name !== unknownSetting && name?.type === "StringLiteral") {
            const type = setting(entry, "type")
            if (type === undefined || (type !== unknownSetting && type.type === "BooleanLiteral" && !type.value)) add(name.value, from)
            else if (type === unknownSetting || type.type !== "BooleanLiteral") unknown.add(from)
          }
          else unknown.add(from)
        }
        else if (key === "presets" && entry.type === "ObjectExpression") {
          const imports = setting(entry, "imports")
          if (imports === unknownSetting || imports?.type !== "ArrayExpression") unknown.add(from)
          else {
            for (const item of imports.elements) {
              const value = item && unwrapExpression(item)
              if (value?.type === "StringLiteral") add(value.value, from)
              else if (value?.type === "ArrayExpression" && value.elements[0]?.type === "StringLiteral" && value.elements[1]?.type === "StringLiteral") add(value.elements[1].value, from)
              else if (value?.type === "ObjectExpression") {
                const name = setting(value, "as") ?? setting(value, "name")
                const type = setting(value, "type")
                if (name === unknownSetting || name?.type !== "StringLiteral" || type === unknownSetting || (type !== undefined && type.type !== "BooleanLiteral")) unknown.add(from)
                else if (!type?.value) add(name.value, from)
              }
              else unknown.add(from)
            }
          }
        }
        else unknown.add(from)
      }
    }
  }
  return { names, unknown }
}

export function serverLayoutFollowUps(layout: NuxtServerLayout) {
  return layout.layers.filter(layer => !layer.server).map(layer => ({
    file: posix.join(layer.directory, layer.config?.fileName ?? "nuxt.config"),
    message: "The server directory could not be resolved statically. Check this layer for server files that need explicit ViteHub imports.",
  }))
}

export function unknownServerImports(sources: ReadonlySet<string>, names: Iterable<string>): string {
  return `The codemod could not determine whether the app provides ${[...names].sort().join(", ")} as server auto-imports (${[...sources].sort().join(", ")}). Check those bindings before changing the code.`
}

function patternExports(node: Node | null | undefined): string[] {
  if (node?.type === "Identifier") return [node.name]
  if (node?.type === "ArrayPattern") return node.elements.flatMap(patternExports)
  if (node?.type === "ObjectPattern") return node.properties.flatMap(property => patternExports(property.type === "RestElement" ? property.argument : property.value))
  if (node?.type === "RestElement") return patternExports(node.argument)
  if (node?.type === "AssignmentPattern") return patternExports(node.left)
  return []
}

async function exportNames(cwd: string, file: string, unknown: Set<string>, seen = new Set<string>()): Promise<Set<string>> {
  const names = new Set<string>()
  if (seen.has(file)) return names
  seen.add(file)
  let program: File
  try {
    program = parseProgram(await readFile(join(cwd, file), "utf8"), { jsx: file.endsWith("x"), typescript: /\.[cm]?tsx?$/.test(file) })
  }
  catch {
    unknown.add(file)
    return names
  }
  for (const statement of program.program.body) {
    if (statement.type === "ExportDefaultDeclaration" && !["TSInterfaceDeclaration", "TSDeclareFunction"].includes(statement.declaration.type)) names.add("default")
    if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type") {
      const specifier = statement.source.value
      const base = posix.join(posix.dirname(file), specifier)
      const target = specifier.startsWith(".") ? await resolveBarrel(cwd, base) : undefined
      if (!target) unknown.add(`${file} (export * from ${JSON.stringify(specifier)})`)
      else for (const name of await exportNames(cwd, target, unknown, seen)) if (name !== "default") names.add(name)
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    const declaration = statement.declaration
    if (declaration && !("declare" in declaration && declaration.declare)) {
      if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration" || declaration.type === "TSEnumDeclaration" || declaration.type === "TSModuleDeclaration") {
        if (declaration.id?.type === "Identifier") names.add(declaration.id.name)
      }
      else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) for (const name of patternExports(declarator.id)) names.add(name)
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ExportSpecifier" && specifier.exportKind === "type") continue
      const name = keyName(specifier.exported)
      if (name) names.add(name)
    }
  }
  return names
}

async function resolveBarrel(cwd: string, base: string): Promise<string | undefined> {
  const source = base.replace(/\.[cm]?js$/, "")
  const extensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]
  const paths = [base, ...extensions.map(extension => `${source}${extension}`), ...extensions.map(extension => `${base}/index${extension}`)]
  const files = new Set(await glob(paths, { cwd, onlyFiles: true }))
  return paths.find(file => files.has(file) && sourceFile.test(file) && !declarationFile.test(file))
}

function defaultExportName(file: string): string {
  const name = basename(file, extname(file))
  return (name === "index" ? basename(dirname(file)) : name).replace(/[-_.\s]+(\w)/g, (_, letter: string) => letter.toUpperCase())
}
