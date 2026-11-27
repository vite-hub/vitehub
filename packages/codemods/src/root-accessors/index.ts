import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, isReference, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import type { File, ImportDeclaration, ObjectExpression, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** An import path whose exports moved to a primitive root. */
interface Move {
  from: string
  to: string
  /** Names that move. Without it, every name moves. */
  names?: ReadonlySet<string>
  /** Names that the new path does not export, with the follow-up for each. */
  removed?: ReadonlyMap<string, string>
  /** Only files in a `server/` directory move. */
  serverOnly?: boolean
}

const removedDatabaseNames = new Map([
  ["databases", "`databases` is no longer public. Use `useDatabase(name)` from the Database root for a named Database."],
  ["agentDb", "`agentDb` is no longer public. Generated Agent routes pass the Database Capability its handle."],
])
const runScheduleNames = new Set(["runSchedule", "RunScheduleOptions"])

/**
 * `root("database")` is the import path of a primitive root that the docs use, `vite-hub/database`, when the app
 * depends on `vite-hub`. An app with only the `@vite-hub/*` packages keeps `@vite-hub/database`.
 */
function moves(root: (name: string) => string): Move[] {
  return [
    { from: "vite-hub/database/drizzle", to: "vite-hub/database", removed: removedDatabaseNames },
    { from: "@vite-hub/database/drizzle", to: root("database"), removed: removedDatabaseNames },
    { from: "vite-hub/email/server", to: "vite-hub/email" },
    { from: "@vite-hub/email/server", to: root("email") },
    {
      from: "#vitehub/env/server",
      to: root("env"),
      removed: new Map([["manageServerEnv", "`manageServerEnv` is not part of the Env root. The Console serves the Env bridge."]]),
    },
    {
      from: "#vitehub/env/public",
      to: root("env"),
      removed: new Map([["publicEnv", "`publicEnv` is not part of the Env root. Call `usePublicEnv()` instead."]]),
      serverOnly: true,
    },
    { from: "vite-hub/schedule/runtime", to: "vite-hub/schedule", names: runScheduleNames },
    { from: "@vite-hub/schedule/runtime", to: root("schedule"), names: runScheduleNames },
  ]
}

const scheduleRegistry = "#vitehub/schedule/registry"
/** Calls whose first argument names a module, such as `vi.mock("vite-hub/email/server")`. */
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

/** Server code: a file in a `server/` directory, a `server*` file such as `src/server.ts`, or one that reads Server Env. */
function isServerFile(file: string, code: string): boolean {
  const segments = file.split("/")
  return segments.includes("server") || /^server\b/.test(segments.at(-1) ?? "") || code.includes("#vitehub/env/server")
}

interface FileContext {
  block: Block
  /** String literals that the codemod rewrote. */
  rewritten: Set<Node>
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  style: CodeStyle
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

function replaceSource(context: FileContext, source: StringLiteral, to: string) {
  const { block, output, style } = context
  output.overwrite(block.offset + start(source), block.offset + end(source), quoteString(to, style))
  context.rewritten.add(source)
}

/** Local names that `runSchedule` has in this block. */
function runScheduleBindings(program: File, scheduleModules: ReadonlySet<string>): Set<string> {
  const names = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !scheduleModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (importedName(specifier) === "runSchedule") names.add(specifier.local.name)
    }
  }
  return names
}

/**
 * Removes the `registry` option from `runSchedule()` calls. The root `runSchedule()` reads the generated registry.
 * Returns the number of calls that still reference `registry` in a way the codemod cannot remove.
 */
function rewriteRunScheduleCalls(context: FileContext, names: ReadonlySet<string>): number {
  const { block, output } = context
  // A local declaration with the same name, such as a parameter, can shadow the import. The codemod has no scope
  // analysis, so it leaves every call in that block for a manual check.
  const shadowed = localDeclarations(context.program, names)
  let kept = 0
  walk(context.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !names.has(node.callee.name)) return
    const options = node.arguments[1]
    if (!options) return
    if (shadowed.has(node.callee.name)) {
      kept++
      followUp(context, node, `\`${node.callee.name}\` is also declared in this file, so the codemod left this call. If it calls \`runSchedule()\`, remove its \`registry\` option.`)
      return
    }
    if (options.type !== "ObjectExpression") {
      kept++
      followUp(context, node, "`runSchedule()` no longer takes a `registry` option. Remove it from these options.")
      return
    }
    const registry = registryProperty(options)
    if (!registry) {
      if (options.properties.some(property => property.type === "SpreadElement")) {
        kept++
        followUp(context, node, "`runSchedule()` no longer takes a `registry` option. Check that the spread options do not pass one.")
      }
      return
    }
    if (options.properties.length === 1) {
      // Remove the argument and the comma before it.
      const first = node.arguments[0]!
      output.remove(block.offset + end(first), block.offset + end(options))
    }
    else {
      const [from, to] = listItemRemoval(block.code, registry)
      output.remove(block.offset + from, block.offset + to)
    }
  })
  return kept
}

function registryProperty(options: ObjectExpression): Node | undefined {
  return options.properties.find(property =>
    property.type === "ObjectProperty"
    && !property.computed
    && ((property.key.type === "Identifier" && property.key.name === "registry") || (property.key.type === "StringLiteral" && property.key.value === "registry")))
}

/** Counts reads of `name` outside import declarations and the `registry` options that the codemod removes. */
function countReferences(program: File, name: string, ignored: (node: Node, ancestors: readonly Node[]) => boolean): number {
  let count = 0
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    if (isReference(node, parent) && node.name === name && !ignored(node, ancestors)) count++
  })
  return count
}

/** True for the value of a `registry` property that `rewriteRunScheduleCalls()` removes, such as `{ registry }`. */
function isRemovedRegistryOption(node: Node, ancestors: readonly Node[], callNames: ReadonlySet<string>): boolean {
  const [call, options, property] = ancestors.slice(-3)
  return call?.type === "CallExpression"
    && call.callee.type === "Identifier"
    && callNames.has(call.callee.name)
    && options?.type === "ObjectExpression"
    && call.arguments[1] === options
    && property?.type === "ObjectProperty"
    && property.value === node
    && registryProperty(options) === property
}

/** How often a function, class, variable, parameter, or catch clause declares each name of `names` in `program`. */
function localDeclarations(program: File, names: ReadonlySet<string>): Map<string, number> {
  const declared = new Map<string, number>()
  const addPattern = (pattern: Node | null | undefined) => {
    if (!pattern) return
    if (pattern.type === "Identifier") {
      if (names.has(pattern.name)) declared.set(pattern.name, (declared.get(pattern.name) ?? 0) + 1)
    }
    else if (pattern.type === "AssignmentPattern") addPattern(pattern.left)
    else if (pattern.type === "RestElement") addPattern(pattern.argument)
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(addPattern)
    else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) addPattern(property.type === "RestElement" ? property.argument : property.value)
    }
    else if (pattern.type === "TSParameterProperty") addPattern(pattern.parameter)
  }
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") addPattern(node.id)
    else if (node.type === "CatchClause") addPattern(node.param)
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "TSDeclareFunction") {
      if ("id" in node) addPattern(node.id)
      node.params.forEach(addPattern)
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") addPattern(node.id)
  })
  return declared
}

/** Methods of a Drizzle client. `useDatabase()` returns `{ db, schema, relations }`, so these calls go through `db`. */
const drizzleMethods = new Set(["$count", "$with", "all", "batch", "delete", "execute", "get", "insert", "query", "run", "select", "selectDistinct", "selectDistinctOn", "transaction", "update", "values", "with"])

/**
 * Use explicit ViteHub imports or the unbound auto-import name. A second declaration makes an imported accessor
 * ambiguous: without scope analysis, keep those calls and their results for manual follow-up.
 */
function databaseQueries(program: File): { insertAt: number[], shadowed: Array<{ node: Node, name: string, method: string, accessor?: string }> } {
  const modules = new Set(["vite-hub/database", "@vite-hub/database", "vite-hub/database/drizzle", "@vite-hub/database/drizzle"])
  const accessors = new Set<string>()
  const imported = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    for (const specifier of statement.specifiers) {
      imported.add(specifier.local.name)
      if (modules.has(statement.source.value) && statement.importKind !== "type" && specifier.type === "ImportSpecifier"
        && specifier.importKind !== "type" && keyName(specifier.imported) === "useDatabase") accessors.add(specifier.local.name)
    }
  }
  const names = new Set([...accessors, "useDatabase"])
  const accessorDeclarations = localDeclarations(program, names)
  if (!imported.has("useDatabase") && !accessorDeclarations.has("useDatabase")) accessors.add("useDatabase")
  const accessorName = (node: Node | null | undefined) =>
    node?.type === "CallExpression" && node.callee.type === "Identifier" && accessors.has(node.callee.name) ? node.callee.name : undefined

  const bindings = new Map<string, string>()
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") return
    const accessor = accessorName(node.init)
    if (accessor) bindings.set(node.id.name, accessor)
  })
  const declarations = bindings.size ? localDeclarations(program, new Set(bindings.keys())) : new Map<string, number>()
  const insertAt: number[] = []
  const shadowed: Array<{ node: Node, name: string, method: string, accessor?: string }> = []
  walk(program, (node) => {
    if (node.type !== "MemberExpression" || node.computed || node.property.type !== "Identifier" || !drizzleMethods.has(node.property.name)) return
    const { object } = node
    const direct = accessorName(object)
    const accessor = direct ?? (object.type === "Identifier" ? bindings.get(object.name) : undefined)
    if (!accessor) return
    const name = direct ? `${direct}()` : object.type === "Identifier" ? object.name : ""
    if (accessorDeclarations.has(accessor)) shadowed.push({ node, name, method: node.property.name, accessor })
    else if (direct || declarations.get(name) === 1) insertAt.push(end(object))
    else shadowed.push({ node, name, method: node.property.name })
  })
  return { insertAt, shadowed }
}

/** Moves Drizzle calls on the result of `useDatabase()` to its `db`. Returns the number of calls it moved. */
function rewriteDatabaseQueries(context: FileContext): number {
  const { insertAt, shadowed } = databaseQueries(context.program)
  for (const at of insertAt) context.output.appendLeft(context.block.offset + at, ".db")
  for (const { node, name, method, accessor } of shadowed) {
    if (accessor) {
      followUp(context, node, `The binding of \`${accessor}\` is ambiguous because this file also declares that name. If \`${name}\` holds a ViteHub Database entry, call \`${name}.db.${method}()\`.`)
      continue
    }
    followUp(context, node, `\`${name}\` is declared more than once in this file, so the codemod left this call. If \`${name}\` holds the result of \`useDatabase()\`, call \`${name}.db.${method}()\`: \`useDatabase()\` returns \`{ db, schema, relations }\`.`)
  }
  return insertAt.length
}

/** Rewrites one script block. Returns true when it changed. */
function rewriteBlock(context: FileContext, movesBySource: ReadonlyMap<string, Move>): boolean {
  const { block, output, program } = context
  const before = output.toString()
  const serverFile = isServerFile(context.file, block.code)
  const applies = (move: Move | undefined): move is Move => Boolean(move && (!move.serverOnly || serverFile))

  // runSchedule() calls first: they decide whether the registry import is still needed.
  const scheduleModules = new Set(["vite-hub/schedule/runtime", "@vite-hub/schedule/runtime", "vite-hub/schedule", "@vite-hub/schedule"])
  const runScheduleNames = runScheduleBindings(program, scheduleModules)
  const keptRegistryCalls = runScheduleNames.size ? rewriteRunScheduleCalls(context, runScheduleNames) : 0

  const imports = new ImportMerger(context)
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === scheduleRegistry) {
      const local = statement.specifiers.find(specifier => specifier.type === "ImportDefaultSpecifier")?.local.name
      const used = local ? countReferences(program, local, (node, ancestors) => isRemovedRegistryOption(node, ancestors, runScheduleNames)) : 0
      // The import stays for other uses, such as `installProcessScheduleRuntime({ registry })`.
      if (local && !used && !keptRegistryCalls && statement.specifiers.length === 1) {
        const [from, to] = listItemRemoval(block.code, statement)
        output.remove(block.offset + from, block.offset + to)
      }
      continue
    }

    if (statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") {
      const move = statement.source ? movesBySource.get(statement.source.value) : undefined
      if (!statement.source || !applies(move)) continue
      if (move.names) {
        followUp(context, statement, `Re-export \`runSchedule\` from \`${move.to}\` and the other names from \`${move.from}\`.`)
        continue
      }
      if (move.removed && statement.type === "ExportNamedDeclaration") {
        const removed = statement.specifiers.flatMap((specifier) => {
          const name = specifier.type === "ExportSpecifier" ? keyName(specifier.local) : undefined
          const message = name ? move.removed!.get(name) : undefined
          return message ? [message] : []
        })
        // The new root does not export these names, so a rewrite would not load. The re-export stays as it is.
        if (removed.length) {
          for (const message of removed) followUp(context, statement, message)
          continue
        }
      }
      if (move.removed && statement.type === "ExportAllDeclaration") {
        followUp(context, statement, `\`export *\` from \`${move.to}\` no longer includes ${[...move.removed.keys()].map(name => `\`${name}\``).join(" or ")}. Check that no importer reads them.`)
      }
      replaceSource(context, statement.source, move.to)
      continue
    }

    if (statement.type !== "ImportDeclaration") continue
    const move = movesBySource.get(statement.source.value)
    if (!applies(move)) {
      imports.register(statement, statement.source.value)
      continue
    }
    for (const specifier of statement.specifiers) {
      const message = move.removed?.get(importedName(specifier) ?? "")
      if (message) followUp(context, specifier, message)
    }
    if (!move.names) {
      if (!imports.merge(statement, statement.specifiers, move.to)) {
        replaceSource(context, statement.source, move.to)
        imports.register(statement, move.to)
      }
      continue
    }
    splitImport(context, statement, move, imports)
  }

  walk(program, (node) => {
    // `declare module "vite-hub/database/drizzle"` and `vi.mock("vite-hub/email/server")`.
    let source: Node | undefined
    // An ambient `declare module "#vitehub/env/server"` would replace the package with the new name, so it stays.
    if (node.type === "TSModuleDeclaration" && node.id.type === "StringLiteral" && !node.id.value.startsWith("#")) source = node.id
    else if (node.type === "ImportExpression") source = node.source
    else if (node.type === "CallExpression" && node.callee.type === "Import") source = node.arguments[0]
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier" && moduleCalls.has(node.callee.property.name)) source = node.arguments[0]
    if (source?.type !== "StringLiteral") return
    const move = movesBySource.get(source.value)
    if (!applies(move) || move.names) return
    replaceSource(context, source, move.to)
    // A dynamic import can read a name that the new root does not export, such as `(await import(...)).agentDb`.
    if (node.type !== "TSModuleDeclaration" && move.removed) {
      const names = [...move.removed.keys()].filter(name => new RegExp(`\\b${name}\\b`).test(block.code))
      if (names.length) followUp(context, node, `This file names ${names.map(name => `\`${name}\``).join(" and ")}, which \`${move.to}\` does not export. Check what this import reads.`)
    }
  })

  // Test stubs and aliases name module paths as plain strings, such as `{ "vite-hub/database/drizzle": "..." }`.
  walk(program, (node) => {
    if (node.type !== "StringLiteral" || context.rewritten.has(node)) return
    const move = movesBySource.get(node.value)
    if (!applies(move)) return
    if (program.program.body.some(statement => (statement.type === "ImportDeclaration" || statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source === node)) return
    followUp(context, node, `This string names \`${move.from}\`. ${move.names ? `\`runSchedule\` moved to \`${move.to}\`` : `Its exports moved to \`${move.to}\``}, so update the stub or alias by hand.`)
  })

  // A database that is not configured now throws, so `useDatabase(name)?.` never reads undefined.
  walk(program, (node, ancestors) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "useDatabase") return
    const parent = ancestors.at(-1)
    if (parent?.type === "OptionalMemberExpression" && parent.object === node && parent.optional) {
      followUp(context, node, "`useDatabase(name)` now throws `DATABASE_NOT_FOUND` for a name without a Database Definition. It never returns `undefined`, so remove the `?.` fallback.")
    }
  })

  return output.toString() !== before
}

type Specifier = ImportDeclaration["specifiers"][number]

/**
 * Joins a moved import with an earlier import of the same path, so a file that imported `defineDatabase` from
 * `vite-hub/database` and `db` from `vite-hub/database/drizzle` ends with one import.
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

/** Moves the names of `move.names` to `move.to`, and keeps the rest. */
function splitImport(context: FileContext, statement: ImportDeclaration, move: Move, imports: ImportMerger) {
  const { block, output, style } = context
  for (const specifier of statement.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier") {
      followUp(context, specifier, `\`runSchedule\` and \`RunScheduleOptions\` moved to \`${move.to}\`. Update reads through this namespace import by hand and remove the \`registry\` option from \`runSchedule()\`.`)
    }
  }
  const moving = statement.specifiers.filter(specifier => move.names!.has(importedName(specifier) ?? ""))
  if (!moving.length) return
  if (moving.length === statement.specifiers.length) {
    if (!imports.merge(statement, moving, move.to)) {
      replaceSource(context, statement.source, move.to)
      imports.register(statement, move.to)
    }
    return
  }
  for (const specifier of moving) {
    const [from, to] = listItemRemoval(block.code, specifier)
    output.remove(block.offset + from, block.offset + to)
  }
  if (imports.merge(statement, moving, move.to)) return
  const typeOnly = statement.importKind === "type" ? "type " : ""
  const names = moving.map(specifier => block.code.slice(start(specifier), end(specifier))).join(", ")
  const semicolon = style.semicolons ? ";" : ""
  output.appendLeft(block.offset + end(statement), `\nimport ${typeOnly}{ ${names} } from ${quoteString(move.to, style)}${semicolon}`)
}

async function rootFor(cwd: string): Promise<(name: string) => string> {
  const manifest = await readFile(join(cwd, "package.json"), "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => undefined)
  const dependencies = [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies]
    .flatMap(value => value && typeof value === "object" ? Object.keys(value) : [])
  const viteHub = dependencies.includes("vite-hub")
  // `#vitehub/env/*` had no package name, so an app with neither package gets `vite-hub/env`, as before.
  return name => viteHub || (name === "env" && !dependencies.includes("@vite-hub/env")) ? `vite-hub/${name}` : `@vite-hub/${name}`
}

async function packageImportsFollowUps(cwd: string): Promise<FollowUp[]> {
  const text = await readFile(join(cwd, "package.json"), "utf8").catch(() => undefined)
  if (!text) return []
  const manifest = JSON.parse(text) as { imports?: Record<string, unknown> }
  return ["#vitehub/env/server", "#vitehub/env/public"]
    .filter(key => manifest.imports && Object.hasOwn(manifest.imports, key))
    .map(key => ({
      file: "package.json",
      line: text.slice(0, text.indexOf(JSON.stringify(key))).split("\n").length,
      message: `\`imports\` maps \`${key}\` by hand. Remove the entry when no file imports it.`,
    }))
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const movesBySource = new Map(moves(await rootFor(cwd)).map(move => [move.from, move]))
  const needles = [...movesBySource.keys(), scheduleRegistry]
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let browserPublicEnv = 0
  let movedImports = 0
  let movedQueries = 0

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needles.some(needle => source.includes(needle)) && !source.includes("useDatabase")) continue
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
      const context: FileContext = { block, file, followUps, output, program, rewritten: new Set(), style: detectStyle(block.code, program) }
      if (rewriteBlock(context, movesBySource)) changed = true
      movedQueries += rewriteDatabaseQueries(context)
      if (!isServerFile(file, block.code) && block.code.includes("#vitehub/env/public")) browserPublicEnv++
    }
    if (changed) movedImports++
    const after = output.toString()
    if (after !== source) edits.push({ path: file, before: source, after })
  }

  followUps.push(...await packageImportsFollowUps(cwd))
  const notes = [
    ...(edits.some(edit => edit.before?.includes("useDatabase")) ? ["`useDatabase(name)` throws `DATABASE_NOT_FOUND` for a name without a Database Definition."] : []),
    ...(browserPublicEnv ? [`${browserPublicEnv} file(s) outside \`server/\` keep \`#vitehub/env/public\`, the browser path of Public Env.`] : []),
  ]
  return {
    summary: [
      ...(movedImports ? [`moved the accessor imports of ${movedImports} file(s) to the primitive roots`] : []),
      ...(movedQueries ? [`moved ${movedQueries} Drizzle call(s) on \`useDatabase()\` to its \`db\``] : []),
    ].join(", and ") || "found no import to move",
    edits,
    followUps,
    notes,
    nextSteps: edits.length ? ["Run your typecheck. The generated types in `.vitehub/types/` type the new imports after `vite dev` or `vitehub types prepare`."] : [],
  }
}

export const rootAccessors: Codemod = {
  name: "root-accessors",
  description: "Import db, schema, useDatabase, email, runSchedule, and the Env accessors from each primitive root, and query through useDatabase().db",
  usage: "[dir]",
  async detect({ cwd }) {
    const paths = moves(name => `vite-hub/${name}`)
    const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
    for (const file of files) {
      const source = await readFile(join(cwd, file), "utf8")
      const move = paths.find(move => source.includes(move.from) && (!move.serverOnly || isServerFile(file, source)))
      if (move) return { reason: `${file} uses ${move.from}` }
      if (!source.includes("useDatabase")) continue
      for (const block of scriptBlocks(file, source)) {
        let program: File
        try {
          program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
        }
        catch {
          continue
        }
        const queries = databaseQueries(program)
        if (queries.insertAt.length || queries.shadowed.some(query => query.accessor)) return { reason: `${file} calls Drizzle methods on the result of useDatabase()` }
      }
    }
    if ((await packageImportsFollowUps(cwd)).length) return { reason: "package.json maps the former Env imports" }
    return undefined
  },
  run: migrate,
}
