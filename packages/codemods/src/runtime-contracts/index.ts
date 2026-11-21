import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, line, listItemRemoval, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { readDependencies } from "../shared/detect.ts"
import { bindingResolver } from "../shared/binding-resolver.ts"
import { rewriteResultCalls, scriptBlocks } from "../shared/result-calls.ts"

import type { File, Identifier, ImportDeclaration, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { ScriptBlock } from "../shared/result-calls.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** The exports of one import path that moved, or that are no longer public. */
interface Move {
  from: string
  /** The new path of the names that move. Without it, no name moves. */
  to?: string
  /** Only these names move. */
  names?: ReadonlySet<string>
  additional?: { to: string, names: ReadonlySet<string> }
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
const authFactory = "Read the discovered Better Auth instance with `useAuth(event)` in a route or `useAuth()` outside a request. To create a handler for another Definition, use `createAuthHandler(definition)`."
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

/** `[name, fix]` pairs for exports that moved to an `internal/*` entry that only ViteHub packages import. */
function internalNames(entries: ReadonlyArray<readonly [names: readonly string[], fix: string]>): Map<string, string> {
  return new Map(entries.flatMap(([names, fix]) => names.map(name => [name, `\`${name}\` is no longer public. ${fix}`] as const)))
}
const packageOnly = "Only ViteHub packages use it. Remove the import."
const consoleLink = "Build a Console link with `hostedConsoleUrl(projectUrl, path)` from `vite-hub/runtime`."
const runtimeRemoved = internalNames([
  [["hostedConsoleOrigin", "normalizeConsolePath", "normalizeConsoleProjectUrl", "consoleInvocationUrl"], consoleLink],
  [["deserializeResponse", "isResponse", "isSerializedResponse", "serializeResponse"], "Return a `Response` from the step, run, or Task. ViteHub stores it and gives it back."],
  [["emitTraceEvent"], "Append to the log of the context with `context.traceLog?.append(event)`."],
  [["createExecutionBudget", "createRuntimeWaitUntilController", "decodeRouteSegment", "encodeRouteSegment", "isExecutionBudgetExceededError", "isResolvable", "isTraceContentAttributeKey", "leaseTable", "resolveRuntimeValue", "runtimeErrorDiagnostics", "traceEventsToOpenTelemetryLogRecords", "traceEventsToOpenTelemetrySpans"], packageOnly],
])
const realtimeRemoved = internalNames([[[
  "applyRealtimeAwarenessUpdate", "applyRealtimeSyncMessage", "assertRealtimeRoomStateQuota", "bindAwarenessIdentity", "claimAwarenessClientIds",
  "compactRealtimeAwareness", "containsRealtimeState", "createRealtimeYDoc", "diffRealtimeYDoc", "encodeAwarenessState", "encodeSyncStep1",
  "encodeSyncUpdate", "isRealtimeWorkspaceDocument", "readRealtimeRequestState", "readRealtimeWorkspaceDocument", "readRealtimeYDoc",
  "realtimePersistenceDefaults", "realtimeRoomKey", "resolveRealtimeDefinition", "restoreRealtimeDocument", "RealtimeSyncOptions",
], "The generated Realtime route uses it. Remove the import."]])
const realtimeRootNames = new Set(["RealtimeDocumentConflict", "isRealtimeDocumentConflict", "readRealtimeStatus", "realtimeDocumentLayout"])
const commentsClientNames = new Set(["commentsErrorDiagnostics"])
const commentsRemoved = internalNames([[["builtinCommentSubjects", "commentsPageScope", "commentsRealtimeDefinition", "commentsRoute", "commentsRuntimeOf", "resolveCommentsRuntime"], "The generated Comments route uses it. Remove the import."]])
const formsGuardNames = new Set(["guardRequest", "GuardedRequest", "GuardRequestOptions", "GuardRequestServices"])
const formsRemoved = internalNames([[["isFormDefinition"], "A file in `server/forms/` default-exports `defineForm()`. ViteHub checks it."]])
const workspaceFilesNames = new Set(["normalizeSafeWorkspacePath", "resolveWorkspaceStoreTarget", "WorkspaceStoreTarget"])
const workspaceRuntimeNames = new Set(["invalidateWorkspaceStore", "resolveRegisteredWorkspaceDefinition"])
const workspaceRemoved = internalNames([[["assertModelWorkspaceGlobPattern", "modelWorkspaceGlobPatternLimits", "resolveWorkspaceAutoCommit", "WorkspaceGlobPatternLimits"], packageOnly]])

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
    { from: "vite-hub/runtime", removed: runtimeRemoved },
    { from: "@vite-hub/runtime", removed: runtimeRemoved },
    { from: "vite-hub/realtime/server", to: "vite-hub/realtime", names: realtimeRootNames, removed: realtimeRemoved },
    { from: "@vite-hub/realtime/server", to: "@vite-hub/realtime", names: realtimeRootNames, removed: realtimeRemoved },
    { from: "vite-hub/comments", to: "vite-hub/comments/client", names: commentsClientNames, removed: commentsRemoved },
    { from: "@vite-hub/comments", to: "@vite-hub/comments/client", names: commentsClientNames, removed: commentsRemoved },
    { from: "vite-hub/forms", removed: new Map([...formsRemoved, ...[...formsGuardNames].map(name => [name, `\`${name}\` moved to \`@vite-hub/forms/guard\`. Install \`@vite-hub/forms\` and import it from there.`] as const)]) },
    { from: "@vite-hub/forms", to: "@vite-hub/forms/guard", names: formsGuardNames, removed: formsRemoved },
    ...["vite-hub/workspace", "@vite-hub/workspace"].map(from => ({
      from,
      to: `${from}/files`,
      names: workspaceFilesNames,
      additional: { to: `${from}/runtime`, names: workspaceRuntimeNames },
      removed: workspaceRemoved,
    })),
  ]
}

const rateLimitModules = new Set(["vite-hub/rate-limit", "@vite-hub/rate-limit"])
/** Calls whose first argument names a module, such as `vi.mock("vite-hub/runtime/h3")`. */
const moduleCalls = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"])
const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

interface FileContext {
  block: ScriptBlock
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

function destination(move: Move, name: string | undefined): string | undefined {
  if (name === undefined || move.removed?.has(name)) return undefined
  if (move.additional?.names.has(name)) return move.additional.to
  if (move.names ? !move.names.has(name) : move.keep?.has(name)) return undefined
  return move.to
}

/** The text of a moved specifier, with the new name when it was renamed. */
function specifierText(context: FileContext, specifier: Specifier, move: Move): string {
  const original = context.block.code.slice(start(specifier), end(specifier))
  const imported = importedName(specifier)
  const renamed = imported ? move.renames?.get(imported) : undefined
  if (!renamed || specifier.type !== "ImportSpecifier") return original
  const from = start(specifier.imported) - start(specifier)
  const to = end(specifier.imported) - start(specifier)
  const alias = start(specifier.local) === start(specifier.imported) ? ` as ${specifier.local.name}` : ""
  return `${original.slice(0, from)}${renamed}${alias}${original.slice(to)}`
}

function replaceSource(context: FileContext, source: StringLiteral, to: string) {
  const { block, output, style } = context
  output.overwrite(block.offset + start(source), block.offset + end(source), quoteString(to, style))
}

/** An import of `to` with named imports in the same file. The moved names join it. */
function joinedImport(context: FileContext, statement: ImportDeclaration, to: string): ImportDeclaration | undefined {
  if (hasImportComments(context, statement)) return undefined
  return context.program.program.body.find((other): other is ImportDeclaration => other.type === "ImportDeclaration"
    && other !== statement
    && other.source.value === to
    && (other.importKind ?? "value") === (statement.importKind ?? "value")
    && other.specifiers.length > 0
    && !hasImportComments(context, other)
    && other.specifiers.every(specifier => specifier.type === "ImportSpecifier"))
}

function hasImportComments(context: FileContext, statement: ImportDeclaration): boolean {
  return context.program.comments?.some(comment => comment.start! >= start(statement) && comment.end! <= end(statement)) ?? false
}

function skipImportTrivia(code: string, offset: number): number {
  return offset + /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/.exec(code.slice(offset))![0].length
}

function splitNamedImports(context: FileContext, statement: ImportDeclaration, move: Move) {
  const { code } = context.block
  const defaultImport = statement.specifiers.find(specifier => specifier.type === "ImportDefaultSpecifier")
  const prefixEnd = skipImportTrivia(code, defaultImport ? end(defaultImport) : start(statement) + "import".length)
  const open = defaultImport ? skipImportTrivia(code, prefixEnd + 1)
    : statement.importKind === "type" ? skipImportTrivia(code, prefixEnd + "type".length) : prefixEnd
  let cursor = open + 1
  const kept: string[] = []
  const moved = new Map<string, string[]>()
  let lastItems = kept
  for (const specifier of statement.specifiers) {
    if (specifier.type !== "ImportSpecifier") continue
    const separator = skipImportTrivia(code, end(specifier))
    const left = code.slice(cursor, start(specifier)).trimStart()
    const right = code.slice(end(specifier), separator).trimEnd()
    const lastComment = right.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/g)?.at(-1)
    const trailingLineComment = lastComment?.startsWith("//")
    const to = destination(move, importedName(specifier))
    const text = to ? specifierText(context, specifier, move) : code.slice(start(specifier), end(specifier))
    lastItems = to ? (moved.get(to) ?? []) : kept
    if (to) moved.set(to, lastItems)
    lastItems.push(left + text + right + (trailingLineComment ? "\n" : ""))
    cursor = code[separator] === "," ? separator + 1 : separator
  }
  const close = skipImportTrivia(code, cursor)
  const afterTrailingComma = code.slice(cursor, close).trimStart()
  if (afterTrailingComma.trim()) {
    const items = kept.length ? kept : lastItems
    items[items.length - 1] += `, ${afterTrailingComma}`
  }
  return { prefixEnd, open, close, kept, moved }
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
  const others = statement.specifiers.filter(specifier => specifier.type !== "ImportSpecifier")
  for (const specifier of others) {
    followUp(context, specifier, `\`${move.from}\` changed: ${describeMove(move)} Update the reads through this ${specifier.type === "ImportNamespaceSpecifier" ? "namespace" : "default"} import by hand.`)
  }
  const moving = statement.specifiers.flatMap((specifier) => {
    const to = destination(move, importedName(specifier))
    return to ? [{ specifier, to }] : []
  })
  if (!moving[0]) return
  const first = moving[0].to
  const destinations = new Set(moving.map(item => item.to))
  for (const to of destinations) context.moved.add(to)
  const target = destinations.size === 1 ? joinedImport(context, statement, first) : undefined
  const wholeImport = moving.length === statement.specifiers.length
  if (wholeImport && destinations.size === 1 && !target) {
    replaceSource(context, statement.source, first)
    for (const { specifier } of moving) {
      const text = specifierText(context, specifier, move)
      if (text !== block.code.slice(start(specifier), end(specifier))) output.overwrite(block.offset + start(specifier), block.offset + end(specifier), text)
    }
    return
  }
  const { prefixEnd, open, close, kept, moved } = splitNamedImports(context, statement, move)
  if (wholeImport && target) {
    const [from, to] = listItemRemoval(block.code, statement)
    output.remove(block.offset + from, block.offset + to)
  }
  else if (wholeImport) {
    replaceSource(context, statement.source, first)
    output.overwrite(block.offset + open + 1, block.offset + close, ` ${moved.get(first)!.join(", ")} `)
    moved.delete(first)
  }
  else if (kept.length) output.overwrite(block.offset + open + 1, block.offset + close, ` ${kept.join(", ")} `)
  else output.remove(block.offset + prefixEnd, block.offset + close + 1)
  // Join an import of the same path, such as `diagnostics` from `vite-hub/agent/capabilities`.
  const typeOnly = statement.importKind === "type" ? "type " : ""
  const semicolon = style.semicolons ? ";" : ""
  for (const [to, items] of moved) {
    const target = joinedImport(context, statement, to)
    if (target) output.appendLeft(block.offset + end(target.specifiers.at(-1)!), `, ${items.join(", ")}`)
    else output.appendLeft(block.offset + end(statement), `\nimport ${typeOnly}{ ${items.join(", ")} } from ${quoteString(to, style)}${semicolon}`)
  }
}

function describeMove(move: Move): string {
  if (move.names) {
    const describe = (names: ReadonlySet<string>, to: string | undefined) => `${[...names].map(name => `\`${name}\``).join(" and ")} moved to \`${to}\`.`
    return move.additional ? `${describe(move.names, move.to)} ${describe(move.additional.names, move.additional.to)}` : describe(move.names, move.to)
  }
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

/**
 * `checkRateLimit()` returns `[error, decision]` now. It threw before, so each call becomes a Result read that throws
 * the error, which keeps the behavior of the code. Other calls get a follow-up.
 */
function rewriteCheckRateLimit(context: FileContext): number {
  const bindings = checkRateLimitBindings(context.program)
  if (!bindings.size) return 0
  const resolveBinding = bindingResolver(context.program)
  return rewriteResultCalls(
    context,
    (call) => {
      if (call.callee.type !== "Identifier") return undefined
      const binding = resolveBinding(call.callee)
      return binding && bindings.has(binding) ? { error: "checkRateLimitError", value: "decision" } : undefined
    },
    call => followUp(context, call, "`checkRateLimit()` returns `[error, decision]` now, and it no longer throws when the request has no key or the Cloudflare binding is missing. Read the decision from the Result: `const [error, decision] = await checkRateLimit(...)`."),
  )
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
  description: "Import getRuntimeContext and getStandardContext from vite-hub/runtime, read checkRateLimit() as a Result, and move private runtime, logs, Auth, Realtime, Comments, Forms, and Workspace imports",
  usage: "[dir]",
  async detect({ cwd }) {
    const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
    for (const file of files) {
      const source = await readFile(join(cwd, file), "utf8")
      // An import of `vite-hub/auth/server` counts only when it names an export that moved or is no longer public.
      const move = moves().find(move => (source.includes(`"${move.from}"`) || source.includes(`'${move.from}'`))
        && ((move.to && !move.names) || move.privatePath || [...move.names ?? [], ...move.removed?.keys() ?? []].some(name => new RegExp(`\\b${name}\\b`).test(source))))
      if (move) return { reason: `${file} imports ${move.from}` }
      if (source.includes("checkRateLimit") && [...rateLimitModules].some(module => source.includes(module))) return { reason: `${file} calls checkRateLimit()` }
    }
    return undefined
  },
  run: migrate,
}
