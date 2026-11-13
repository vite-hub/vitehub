import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, indentAt, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { readDependencies } from "../shared/detect.ts"
import { bindingResolver } from "../shared/binding-resolver.ts"

import type { File, Identifier, ImportDeclaration, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** The exports of one import path that moved, or that are no longer public. */
interface Move {
  from: string
  /** The new path of the names that move. Without it, no name moves. */
  to?: string
  /** Only these names move. */
  names?: ReadonlySet<string>
  /** Every name moves except these. */
  keep?: ReadonlySet<string>
  /** Names that have another name at `to`. The local name stays. */
  renames?: ReadonlyMap<string, string>
  /** Names that are no longer public, with the follow-up for each. They stay in the import. */
  removed?: ReadonlyMap<string, string>
  /** The whole path is no longer public. */
  privatePath?: string
}

const h3Renames = new Map([
  ["H3RuntimeContext", "RequestRuntimeContext"],
  ["H3RuntimeContextOptions", "RuntimeContextOptions"],
])
const h3Removed = new Map([
  ["installStandardContext", "`installStandardContext` is no longer public. ViteHub sets `event[\"~standard\"]` on each request, and the primitives set it for an event that Nitro did not create. Remove the import and its calls."],
])
const nodeNames = new Set(["nodeRuntimeResources", "NodeRuntimeResourceInspectorOptions"])
const logNames = new Set(["createLogBuffer", "LogBuffer", "LogCursorExpiredError", "parseLogQuery", "LogEntry", "LogLevel", "LogPage", "LogQuery", "LogSource", "LogSourceInfo"])

const authSetter = "ViteHub sets it in generated code. Remove the call. To read host bindings, use the request event: `getStandardContext(event).runtime.cloudflare.env` from `vite-hub/runtime`."
const authFactory = "Read the discovered Better Auth instance with `useAuth(event)` or `auth`, or create a handler for another Definition with `createAuthHandler(definition)`."
const authAccess = "Configure `access.routes` in `defineAuth()`. The generated middleware checks them on each request."
const authRemoved = new Map<string, string>([
  ["resetAuth", authSetter],
  ["setAuthAccessIdentityResolver", authSetter],
  ["setAuthRuntimeEnvResolver", authSetter],
  ["createAuth", authFactory],
  ["createAuthForRequest", authFactory],
  ["createAuthRequestRuntimeOptions", authFactory],
  ["createBetterAuthOptions", authFactory],
  ["getAuthForDefinition", authFactory],
  ["getAuthForRequest", "Read the request instance with `useAuth(event)`."],
  ["getAuthorization", "Read the checked session with `await requireAuth(event)` inside the handler."],
  ["handleAuthRequest", "Use `handleAuth(input)` for the discovered Definition, or `createAuthHandler(definition)` for another one."],
  ["toAuthRequest", "Read the Request with `getStandardContext(event).req` from `vite-hub/runtime`, or pass the Request itself."],
  ["createAuthAccessHandler", authAccess],
  ["requireAuthAccessRoutes", authAccess],
  ["assertAuthOrigin", "Check the origin with `useAuth(event).$context` and its `isTrustedOrigin()`."],
].map(([name, fix]) => [name, `\`${name}\` is no longer public. ${fix}`]))
const authPrivate = "ViteHub imports it in generated code. Remove the import."

function moves(): Move[] {
  return [
    { from: "vite-hub/runtime/h3", to: "vite-hub/runtime", renames: h3Renames, removed: h3Removed },
    { from: "@vite-hub/runtime/h3", to: "@vite-hub/runtime", renames: h3Renames, removed: h3Removed },
    { from: "vite-hub/runtime/node", to: "vite-hub/agent/capabilities", names: nodeNames },
    { from: "@vite-hub/runtime/node", to: "@vite-hub/agent/capabilities", names: nodeNames },
    { from: "@vite-hub/runtime/shutdown", privatePath: "`@vite-hub/runtime/shutdown` is no longer public. ViteHub drains its own work on `SIGTERM`. Remove the import." },
    { from: "vite-hub/logs", to: "evlog", keep: logNames },
    { from: "vite-hub/auth/server", removed: authRemoved },
    { from: "@vite-hub/auth/server", removed: authRemoved },
    { from: "vite-hub/auth/runtime/server", privatePath: `\`vite-hub/auth/runtime/server\` is no longer public. ${authPrivate}` },
    { from: "vite-hub/auth/console", privatePath: `\`vite-hub/auth/console\` is no longer public. ${authPrivate}` },
    { from: "vite-hub/auth/console-runtime", privatePath: "`vite-hub/auth/console-runtime` is no longer public. Read users and sessions with `getAuthConsoleForRequest(request)` from `vite-hub/auth/server`." },
  ]
}

const rateLimitModules = new Set(["vite-hub/rate-limit", "@vite-hub/rate-limit"])
/** Calls whose first argument names a module, such as `vi.mock("vite-hub/runtime/h3")`. */
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
  style: CodeStyle
  /** Moved names per target path, for the report. */
  moved: Set<string>
}

type Specifier = ImportDeclaration["specifiers"][number]

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function importedName(specifier: Specifier): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

function isMoving(move: Move, name: string | undefined): boolean {
  if (!move.to || name === undefined || move.removed?.has(name)) return false
  if (move.names) return move.names.has(name)
  if (move.keep) return !move.keep.has(name)
  return true
}

/** The text of a moved specifier, with the new name when it was renamed. */
function specifierText(context: FileContext, specifier: Specifier, move: Move): string {
  const original = context.block.code.slice(start(specifier), end(specifier))
  const imported = importedName(specifier)
  const renamed = imported ? move.renames?.get(imported) : undefined
  if (!renamed || specifier.type !== "ImportSpecifier") return original
  const typeOnly = specifier.importKind === "type" ? "type " : ""
  return `${typeOnly}${renamed} as ${specifier.local.name}`
}

function replaceSource(context: FileContext, source: StringLiteral, to: string) {
  const { block, output, style } = context
  output.overwrite(block.offset + start(source), block.offset + end(source), quoteString(to, style))
}

/** An import of `to` with named imports in the same file. The moved names join it. */
function joinedImport(context: FileContext, statement: ImportDeclaration, to: string): ImportDeclaration | undefined {
  return context.program.program.body.find((other): other is ImportDeclaration => other.type === "ImportDeclaration"
    && other !== statement
    && other.source.value === to
    && (other.importKind ?? "value") === (statement.importKind ?? "value")
    && other.specifiers.length > 0
    && other.specifiers.every(specifier => specifier.type === "ImportSpecifier"))
}

/** Rewrites one import of a moved path. */
function rewriteImport(context: FileContext, statement: ImportDeclaration, move: Move) {
  const { block, output, style } = context
  if (move.privatePath) {
    followUp(context, statement, move.privatePath)
    return
  }
  for (const specifier of statement.specifiers) {
    const message = move.removed?.get(importedName(specifier) ?? "")
    if (message) followUp(context, specifier, message)
  }
  if (!move.to) return
  const named = statement.specifiers.filter(specifier => specifier.type === "ImportSpecifier")
  const others = statement.specifiers.filter(specifier => specifier.type !== "ImportSpecifier")
  for (const specifier of others) {
    followUp(context, specifier, `\`${move.from}\` changed: ${describeMove(move)} Update the reads through this ${specifier.type === "ImportNamespaceSpecifier" ? "namespace" : "default"} import by hand.`)
  }
  const moving = named.filter(specifier => isMoving(move, importedName(specifier)))
  if (!moving.length) return
  context.moved.add(move.to)
  const texts = moving.map(specifier => specifierText(context, specifier, move))
  if (moving.length === statement.specifiers.length && !joinedImport(context, statement, move.to)) {
    replaceSource(context, statement.source, move.to)
    moving.forEach((specifier, index) => {
      const text = texts[index]!
      if (text !== block.code.slice(start(specifier), end(specifier))) output.overwrite(block.offset + start(specifier), block.offset + end(specifier), text)
    })
    return
  }
  for (const node of moving.length === statement.specifiers.length ? [statement] : moving) {
    const [from, to] = listItemRemoval(block.code, node)
    output.remove(block.offset + from, block.offset + to)
  }
  // Join an import of the same path, such as `diagnostics` from `vite-hub/agent/capabilities`.
  const target = joinedImport(context, statement, move.to)
  if (target) {
    output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${texts.join(", ")}`)
    return
  }
  const typeOnly = statement.importKind === "type" ? "type " : ""
  const semicolon = style.semicolons ? ";" : ""
  output.appendLeft(block.offset + end(statement), `\nimport ${typeOnly}{ ${texts.join(", ")} } from ${quoteString(move.to, style)}${semicolon}`)
}

function describeMove(move: Move): string {
  if (move.names) return `${[...move.names].map(name => `\`${name}\``).join(" and ")} moved to \`${move.to}\`.`
  if (move.keep) return `the names that ViteHub does not own moved to \`${move.to}\`.`
  return `its exports moved to \`${move.to}\`.`
}

/** Import bindings of `checkRateLimit` in this block. */
function checkRateLimitBindings(program: File): Set<Identifier> {
  const bindings = new Set<Identifier>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !rateLimitModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (importedName(specifier) === "checkRateLimit") bindings.add(specifier.local)
    }
  }
  return bindings
}

/** Names that a declaration, parameter, or import in `program` binds. */
function declaredNames(program: File): Set<string> {
  const names = new Set<string>()
  walk(program, (node) => {
    if (node.type === "Identifier") names.add(node.name)
  })
  return names
}

/**
 * `checkRateLimit()` returns `[error, decision]` now. It threw before, so `const decision = await checkRateLimit(...)`
 * becomes a Result read that throws the error, which keeps the behavior of the code.
 */
function rewriteCheckRateLimit(context: FileContext): number {
  const { block, output, program, style } = context
  const bindings = checkRateLimitBindings(program)
  if (!bindings.size) return 0
  const resolveBinding = bindingResolver(program)
  const taken = declaredNames(program)
  let rewritten = 0
  const errorName = () => {
    let index = 1
    let name = "checkRateLimitError"
    while (taken.has(name)) name = `checkRateLimitError${++index}`
    taken.add(name)
    return name
  }
  walk(program, (node, ancestors) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
    const binding = resolveBinding(node.callee)
    if (!binding || !bindings.has(binding)) return
    const [declaration, declarator, awaited] = ancestors.slice(-3)
    const owner = ancestors.at(-4)
    const statementList = owner && (owner.type === "BlockStatement" || owner.type === "Program") ? owner.body : undefined
    if (
      awaited?.type === "AwaitExpression"
      && declarator?.type === "VariableDeclarator"
      && declarator.init === awaited
      && declarator.id.type === "Identifier"
      && declaration?.type === "VariableDeclaration"
      && declaration.declarations.length === 1
      && (statementList as readonly Node[] | undefined)?.includes(declaration)
    ) {
      const error = errorName()
      const semicolon = style.semicolons || block.code[end(declaration) - 1] === ";" ? ";" : ""
      const id = declarator.id
      output.overwrite(block.offset + start(id), block.offset + end(id), `[${error}, ${id.name}]`)
      output.appendLeft(block.offset + end(declaration), `\n${indentAt(block.code, start(declaration))}if (${error}) throw ${error}${semicolon}`)
      rewritten++
      return
    }
    followUp(context, node, "`checkRateLimit()` returns `[error, decision]` now, and it no longer throws when the request has no key or the Cloudflare binding is missing. Read the decision from the Result: `const [error, decision] = await checkRateLimit(...)`.")
  })
  return rewritten
}

/** Rewrites one script block. Returns true when it changed. */
function rewriteBlock(context: FileContext, movesBySource: ReadonlyMap<string, Move>): boolean {
  const { output, program } = context
  const before = output.toString()
  rewriteCheckRateLimit(context)
  for (const statement of program.program.body) {
    if (statement.type === "ImportDeclaration") {
      const move = movesBySource.get(statement.source.value)
      if (move) rewriteImport(context, statement, move)
      continue
    }
    if ((statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration") && statement.source) {
      const move = movesBySource.get(statement.source.value)
      if (move) followUp(context, statement, move.privatePath ?? `\`${move.from}\` changed: ${move.to ? describeMove(move) : "some names are no longer public."} Update this re-export by hand.`)
    }
  }
  walk(program, (node) => {
    let source: Node | undefined
    if (node.type === "ImportExpression") source = node.source
    else if (node.type === "CallExpression" && node.callee.type === "Import") source = node.arguments[0]
    else if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier" && moduleCalls.has(node.callee.property.name)) source = node.arguments[0]
    else if (node.type === "TSModuleDeclaration" && node.id.type === "StringLiteral") source = node.id
    if (source?.type !== "StringLiteral") return
    const move = movesBySource.get(source.value)
    if (!move) return
    if (move.to && !move.names && !move.keep && !move.removed?.size && !move.renames?.size) {
      replaceSource(context, source, move.to)
      return
    }
    followUp(context, node, move.privatePath ?? `\`${move.from}\` changed: ${move.to ? describeMove(move) : "some names are no longer public."} Update this module path by hand.`)
  })
  return output.toString() !== before
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const movesBySource = new Map(moves().map(move => [move.from, move]))
  const needles = [...movesBySource.keys(), "checkRateLimit"]
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const moved = new Set<string>()

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needles.some(needle => source.includes(needle))) continue
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
      const context: FileContext = { block, file, followUps, moved, output, program, style: detectStyle(block.code, program) }
      if (rewriteBlock(context, movesBySource)) changed = true
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }

  const dependencies = await readDependencies(cwd)
  const nextSteps = [
    ...(moved.has("evlog") && !dependencies.has("evlog") ? ["Install `evlog`, which the Evlog imports now name: `pnpm add evlog`."] : []),
    ...(edits.length ? ["Run your typecheck."] : []),
  ]
  return {
    summary: edits.length ? `moved the runtime, logs, and Rate Limit imports of ${edits.length} file(s)` : "found no import to move",
    edits,
    followUps,
    notes: [],
    nextSteps,
  }
}

export const runtimeContracts: Codemod = {
  name: "runtime-contracts",
  description: "Import getRuntimeContext and getStandardContext from vite-hub/runtime, read checkRateLimit() as a Result, and move private runtime, logs, and Auth imports",
  usage: "[dir]",
  async detect({ cwd }) {
    const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
    for (const file of files) {
      const source = await readFile(join(cwd, file), "utf8")
      // An import of `vite-hub/auth/server` counts only when it names an export that is no longer public.
      const move = moves().find(move => (source.includes(`"${move.from}"`) || source.includes(`'${move.from}'`))
        && (move.to || move.privatePath || [...move.removed?.keys() ?? []].some(name => new RegExp(`\\b${name}\\b`).test(source))))
      if (move) return { reason: `${file} imports ${move.from}` }
      if (source.includes("checkRateLimit") && [...rateLimitModules].some(module => source.includes(module))) return { reason: `${file} calls checkRateLimit()` }
    }
    return undefined
  },
  run: migrate,
}
