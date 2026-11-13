import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { readDependencies } from "../shared/detect.ts"

import type { File, ImportDeclaration, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Subpaths that moved into another entry of the same package, without `vite-hub/` or `@vite-hub/`. */
const subpathMoves: ReadonlyArray<readonly [from: string, to: string]> = [
  ...["file", "files", "github", "glob", "markdown"].map(name => [`source/${name}`, "source"] as const),
  ...["presets", "provider", "schema", "secret"].map(name => [`env/${name}`, "env"] as const),
  ["env/auth", "env/bridge"],
  ["env/http", "env/bridge"],
  ["blob/content-type", "blob"],
  ["blob/ensure", "blob"],
  ["blob/reference", "blob"],
  ["browser/actions", "browser"],
  ["connections/http", "connections"],
]

const movedPaths = new Map(subpathMoves.flatMap(([from, to]) => [
  [`vite-hub/${from}`, `vite-hub/${to}`],
  [`@vite-hub/${from}`, `@vite-hub/${to}`],
]))

/** `vite-hub/task` re-exported Nitro's task API. Values come from `nitro/task`, types from `nitro/types`. */
const taskPath = "vite-hub/task"
const taskValuesPath = "nitro/task"
const taskTypesPath = "nitro/types"
const taskTypeNames = new Set(["Task", "TaskContext", "TaskEvent", "TaskMeta", "TaskPayload", "TaskResult"])

/** Calls whose first argument names a module, such as `vi.mock("vite-hub/browser/actions")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

interface Block {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

function scriptBlocks(file: string, source: string): Block[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{
      code: block.content,
      offset: block.loc.start.offset,
      lineOffset: block.loc.start.line - 1,
      jsx: lang === "tsx" || lang === "jsx",
      typescript: lang === "ts" || lang === "tsx",
    }]
  })
}

interface FileContext {
  block: Block
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  /** String literals that the codemod rewrote. */
  rewritten: Set<Node>
  style: CodeStyle
  /** The block named `vite-hub/task`, which moves to the `nitro` package. */
  task: boolean
}

type Specifier = ImportDeclaration["specifiers"][number]

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function importedName(specifier: Specifier): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

function replaceSource(context: FileContext, source: StringLiteral, to: string) {
  const { block, output, style } = context
  output.overwrite(block.offset + start(source), block.offset + end(source), quoteString(to, style))
  context.rewritten.add(source)
}

/** `detectContentType` also has a browser entry. Browser code moves to it, not to the server root. */
const clientMoves = new Map([
  ["vite-hub/blob/content-type", "vite-hub/blob/client"],
  ["@vite-hub/blob/content-type", "@vite-hub/blob/client"],
])

/** Server code: a file in a `server/` directory, or a `server*` or `*.server.*` file such as `src/server.ts`. */
function isServerFile(file: string): boolean {
  const segments = file.split("/")
  const name = segments.at(-1) ?? ""
  return segments.includes("server") || /^server\b/.test(name) || /\.server\.[^/]+$/.test(name)
}

/** The path that replaces `from` in `file`, or undefined when `from` did not move. */
function movedTo(from: string, file: string): string | undefined {
  if (from === taskPath) return taskValuesPath
  // The signature helper is portable. Keep shared and unclassified files safe for browser consumers.
  return (!isServerFile(file) ? clientMoves.get(from) : undefined) ?? movedPaths.get(from)
}

/**
 * Joins a moved import with an earlier import of the same path, so a file that imported `createSource` from
 * `vite-hub/source` and `glob` from `vite-hub/source/glob` ends with one import.
 */
class ImportMerger {
  private readonly context: FileContext
  private readonly targets = new Map<string, ImportDeclaration>()

  constructor(context: FileContext) {
    this.context = context
  }

  private key(statement: ImportDeclaration, source: string): string | undefined {
    const named = statement.specifiers.length > 0 && statement.specifiers.every(specifier => specifier.type === "ImportSpecifier")
    return named ? `${statement.importKind ?? "value"}:${source}` : undefined
  }

  register(statement: ImportDeclaration, source: string) {
    const key = this.key(statement, source)
    if (key && !this.targets.has(key)) this.targets.set(key, statement)
  }

  /** Adds `specifiers` to an earlier import of `source`. Removes `statement` when all of its names move there. */
  merge(statement: ImportDeclaration, specifiers: readonly Specifier[], source: string): boolean {
    const key = this.key(statement, source)
    const target = key ? this.targets.get(key) : undefined
    if (!target || target === statement) return false
    const { block, output } = this.context
    const names = specifiers.map(specifier => block.code.slice(start(specifier), end(specifier))).join(", ")
    output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${names}`)
    if (specifiers.length === statement.specifiers.length) {
      const [from, to] = listItemRemoval(block.code, statement)
      output.remove(block.offset + from, block.offset + to)
    }
    return true
  }
}

/** Moves one import of a moved path, and joins it with an earlier import of the new path. */
function moveImport(context: FileContext, statement: ImportDeclaration, to: string, imports: ImportMerger) {
  if (!imports.merge(statement, statement.specifiers, to)) {
    replaceSource(context, statement.source, to)
    imports.register(statement, to)
  }
}

/** Splits an import of `vite-hub/task`: values go to `nitro/task`, types to `nitro/types`. */
function moveTaskImport(context: FileContext, statement: ImportDeclaration, imports: ImportMerger) {
  const { block, output, style } = context
  if (statement.specifiers.some(specifier => specifier.type !== "ImportSpecifier")) {
    replaceSource(context, statement.source, taskValuesPath)
    if (statement.specifiers.some(specifier => specifier.type === "ImportNamespaceSpecifier")) {
      followUp(context, statement, "`nitro/task` has `defineTask` and `runTask`. Import the task types, such as `TaskEvent`, from `nitro/types`.")
    }
    return
  }
  const isType = (specifier: Specifier) => statement.importKind === "type" || (specifier.type === "ImportSpecifier" && specifier.importKind === "type") || taskTypeNames.has(importedName(specifier) ?? "")
  const types = statement.specifiers.filter(isType)
  if (!types.length) return moveImport(context, statement, taskValuesPath, imports)
  if (types.length === statement.specifiers.length) {
    if (statement.importKind === "type") return moveImport(context, statement, taskTypesPath, imports)
    replaceSource(context, statement.source, taskTypesPath)
    return
  }
  const text = (specifier: Specifier) => block.code.slice(start(specifier), end(specifier)).replace(/^type\s+/, "")
  const values = statement.specifiers.filter(specifier => !types.includes(specifier))
  output.overwrite(block.offset + start(statement.specifiers[0]!), block.offset + end(statement.specifiers.at(-1)!), values.map(text).join(", "))
  replaceSource(context, statement.source, taskValuesPath)
  const names = types.map(text).join(", ")
  const semicolon = style.semicolons ? ";" : ""
  output.appendLeft(block.offset + end(statement), `\nimport type { ${names} } from ${quoteString(taskTypesPath, style)}${semicolon}`)
}

/** Rewrites one script block. Returns true when it changed. */
function rewriteBlock(context: FileContext): boolean {
  const { program } = context
  const before = context.output.toString()
  const imports = new ImportMerger(context)

  // Imports of paths that stay, so a moved import joins one even when it comes later in the file.
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration" && !movedTo(statement.source.value, context.file)) imports.register(statement, statement.source.value)
  }

  for (const statement of program.program.body) {
    if (statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") {
      const from = statement.source?.value
      const to = from ? movedTo(from, context.file) : undefined
      if (!statement.source || !from || !to) continue
      if (from === taskPath) {
        context.task = true
        followUp(context, statement, "Re-export `defineTask` and `runTask` from `nitro/task`, and the task types from `nitro/types`.")
        continue
      }
      replaceSource(context, statement.source, to)
      continue
    }

    if (statement.type !== "ImportDeclaration") continue
    const from = statement.source.value
    const to = movedTo(from, context.file)
    if (!to) continue
    if (from === taskPath) {
      context.task = true
      moveTaskImport(context, statement, imports)
    }
    else moveImport(context, statement, to, imports)
  }

  walk(program, (node) => {
    // `declare module "vite-hub/env/presets"`, `import("vite-hub/source/glob")`, and `vi.mock("vite-hub/browser/actions")`.
    let source: Node | undefined
    if (node.type === "TSModuleDeclaration" && node.id.type === "StringLiteral") source = node.id
    else if (node.type === "ImportExpression") source = node.source
    else if (node.type === "CallExpression" && node.callee.type === "Import") source = node.arguments[0]
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier" && moduleCalls.has(node.callee.property.name)) source = node.arguments[0]
    else if (node.type === "TSImportType") source = node.argument
    if (source?.type !== "StringLiteral" || context.rewritten.has(source)) return
    const to = movedTo(source.value, context.file)
    if (!to) return
    if (source.value === taskPath) {
      context.task = true
      followUp(context, node, "`vite-hub/task` is gone. Use `nitro/task` for `defineTask` and `runTask`, and `nitro/types` for the task types.")
      return
    }
    replaceSource(context, source, to)
  })

  // Aliases, test stubs, and `runtimeImports` options name module paths as plain strings.
  walk(program, (node) => {
    if (node.type !== "StringLiteral" || context.rewritten.has(node)) return
    const to = movedTo(node.value, context.file)
    if (!to) return
    if (program.program.body.some(statement => (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source === node)) return
    followUp(context, node, `This string names \`${node.value}\`. Its exports moved to \`${to}\`${node.value === taskPath ? " and `nitro/types`" : ""}, so update it by hand.`)
  })

  return context.output.toString() !== before
}

function mentionsMovedPath(source: string): boolean {
  return source.includes(taskPath) || [...movedPaths.keys()].some(path => source.includes(path))
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let task = false

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!mentionsMovedPath(source)) continue
    const output = new MagicString(source)
    let changed = false
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Move its imports by hand.` })
        continue
      }
      const context: FileContext = { block, file, followUps, output, program, rewritten: new Set(), style: detectStyle(block.code, program), task: false }
      if (rewriteBlock(context)) changed = true
      if (context.task) task = true
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }

  const dependencies = await readDependencies(cwd)
  if (task && !dependencies.has("nitro") && !dependencies.has("nuxt")) {
    followUps.push({ file: "package.json", message: "`nitro/task` comes from the `nitro` package. Add `nitro` to `dependencies`." })
  }
  return {
    summary: edits.length ? `moved the imports of ${edits.length} file(s) to one entry per concept` : "found no import to move",
    edits,
    followUps,
    notes: [],
    nextSteps: edits.length ? ["Run your typecheck."] : [],
  }
}

export const oneEntryImports: Codemod = {
  name: "one-entry-imports",
  description: "Import Source factories, Env, Blob, Browser, and Connections helpers from one entry each, and Nitro tasks from nitro/task",
  usage: "[dir]",
  async detect({ cwd }) {
    const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
    for (const file of files) {
      const source = await readFile(join(cwd, file), "utf8")
      const path = [taskPath, ...movedPaths.keys()].find(path => new RegExp(`["'\`]${path.replace(/[/.]/g, "\\$&")}["'\`]`).test(source))
      if (path) return { reason: `${file} imports ${path}` }
    }
    return undefined
  },
  run: migrate,
}
