import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { enclosingFunction, rewriteResultCalls, scriptBlocks } from "../shared/result-calls.ts"

import type { CallExpression, File, Identifier, ImportDeclaration } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { ResultCall, ResultCallContext } from "../shared/result-calls.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const workflowModules = new Set(["vite-hub/workflow", "@vite-hub/workflow"])
// `root-accessors` moves the `/runtime` imports to the root in the same `vitehub migrate` run.
const scheduleModules = new Set(["vite-hub/schedule", "@vite-hub/schedule", "vite-hub/schedule/runtime", "@vite-hub/schedule/runtime"])
const authModules = new Set(["vite-hub/auth/server", "@vite-hub/auth/server", "vite-hub/auth/runtime/console", "@vite-hub/auth/runtime/console"])
const browserModules = new Set(["vite-hub/browser", "@vite-hub/browser"])
const sandboxTaskModules = new Set(["vite-hub/sandbox/task", "@vite-hub/sandbox/task"])
const gatewayModules = new Set(["vite-hub/gateways", "@vite-hub/gateways"])
const modules = [workflowModules, scheduleModules, authModules, browserModules, sandboxTaskModules, gatewayModules]

interface ResultFunction {
  modules: ReadonlySet<string>
  /** The name of the value variable. */
  value: string
  /** `vite-hub/nuxt` auto-imports the function in server code. */
  autoImport?: boolean
  /** The call returned a `Response` before. Code that read the `Response` cannot become a Result read. */
  returnedResponse?: boolean
}

/** Functions that return `[error, data]` now, with the modules that export them. They threw or returned a `Response` before. */
const resultFunctions = new Map<string, ResultFunction>([
  ["startWorkflow", { modules: workflowModules, value: "run", autoImport: true }],
  ["getWorkflowRun", { modules: workflowModules, value: "run", autoImport: true }],
  ["cancelWorkflow", { modules: workflowModules, value: "run", autoImport: true }],
  ["resumeWorkflow", { modules: workflowModules, value: "signal", autoImport: true }],
  ["runSchedule", { modules: scheduleModules, value: "run" }],
  ["listAuthEvents", { modules: authModules, value: "page" }],
  ["aggregateAuthEvents", { modules: authModules, value: "totals" }],
  ["runBrowserContent", { modules: browserModules, value: "html" }],
  ["runBrowser", { modules: browserModules, value: "data", autoImport: true, returnedResponse: true }],
  ["runSandboxTask", { modules: sandboxTaskModules, value: "data", autoImport: true, returnedResponse: true }],
])

type HandleKind = "workflow" | "gateway"

/** Functions that return a handle, and the methods of the handle that return `[error, data]` now, with their value names. */
const handleFactories = new Map<string, { modules: ReadonlySet<string>, kind: HandleKind, autoImport?: boolean }>([
  ["createWorkflow", { modules: workflowModules, kind: "workflow", autoImport: true }],
  // Only these gateways have `ask()`.
  ["typesafe", { modules: gatewayModules, kind: "gateway" }],
  ["vercel", { modules: gatewayModules, kind: "gateway" }],
  ["cloudflare", { modules: gatewayModules, kind: "gateway" }],
  ["askWithModel", { modules: gatewayModules, kind: "gateway" }],
])
const handleMethods: Record<HandleKind, ReadonlyMap<string, string>> = {
  workflow: new Map([["start", "run"], ["getRun", "run"], ["cancel", "run"]]),
  gateway: new Map([["ask", "answers"]]),
}
const needles = [...resultFunctions.keys(), ...handleFactories.keys()]

function isExport(name: string, source: string): boolean {
  return resultFunctions.get(name)?.modules.has(source) === true || handleFactories.get(name)?.modules.has(source) === true
}

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/** Local bindings of the imports that this codemod reads in this block, by their exported name. */
function resultImports(program: File): Map<Identifier, { name: string, source: string }> {
  const bindings = new Map<Identifier, { name: string, source: string }>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    const source = statement.source.value
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier" && modules.some(set => set.has(source))) bindings.set(specifier.local, { name: "*", source })
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const name = importedName(specifier)
      if (name && isExport(name, source)) bindings.set(specifier.local, { name, source })
    }
  }
  return bindings
}

/** The callee of a call as the code writes it, such as `startWorkflow` or `onboard.start`. */
function calleeText(call: CallExpression, code: string): string {
  return code.slice(start(call.callee), end(call.callee))
}

interface BlockContext extends ResultCallContext {
  file: string
  followUps: FollowUp[]
  /** Nuxt auto-imports the Workflow, Browser, and Sandbox helpers in server code, so a name that the file does not declare counts there. */
  autoImports: boolean
  /** A Nitro route file, where a returned value is the response. */
  route: boolean
}

function migrateBlock(context: BlockContext): number {
  const { autoImports, block, file, followUps, program, route } = context
  const imports = resultImports(program)
  if (!imports.size && !autoImports) return 0
  const resolveBinding = bindingResolver(program)
  const exportedName = (node: Node): string | undefined => {
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const binding = resolveBinding(node.object)
      const imported = binding && imports.get(binding)
      if (imported?.name !== "*") return undefined
      const name = memberName(node)
      return name && isExport(name, imported.source) ? name : undefined
    }
    if (node.type !== "Identifier") return undefined
    const binding = resolveBinding(node)
    if (binding) return imports.get(binding)?.name
    return autoImports && (resultFunctions.get(node.name)?.autoImport || handleFactories.get(node.name)?.autoImport) ? node.name : undefined
  }
  // `const onboard = createWorkflow(...)` makes `onboard` a Workflow handle, and `const gateway = typesafe()` a gateway.
  const handles = new Map<Identifier, HandleKind>()
  const handleKind = (node: Node): HandleKind | undefined => {
    if (node.type === "CallExpression") {
      const name = exportedName(node.callee)
      return name ? handleFactories.get(name)?.kind : undefined
    }
    if (node.type !== "Identifier") return undefined
    const binding = resolveBinding(node)
    return binding && handles.get(binding)
  }
  let previousSize: number
  do {
    previousSize = handles.size
    walk(program, (node) => {
      const kind = node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init ? handleKind(node.init) : undefined
      if (kind && node.type === "VariableDeclarator" && node.id.type === "Identifier") handles.set(node.id, kind)
    })
  } while (previousSize !== handles.size)
  const exportedHandles = new Set<Identifier>()
  const addExport = (local: Identifier) => {
    const binding = resolveBinding(local)
    if (binding && handles.has(binding)) exportedHandles.add(binding)
  }
  for (const statement of program.program.body) {
    if (statement.type === "ExportNamedDeclaration" && !statement.source && statement.exportKind !== "type") {
      if (statement.declaration?.type === "VariableDeclaration") {
        for (const { id } of statement.declaration.declarations) if (id.type === "Identifier") addExport(id)
      }
      for (const specifier of statement.specifiers) if (specifier.type === "ExportSpecifier" && specifier.exportKind !== "type") addExport(specifier.local)
    }
    else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration
      if (declaration.type === "Identifier") addExport(declaration)
      else if (declaration.type === "CallExpression" && handleKind(declaration) === "gateway") {
        followUps.push({ file, line: block.lineOffset + line(declaration), message: `\`${calleeText(declaration, block.code)}()\` is an exported gateway. In other files, read \`.ask()\` as \`[error, answers]\`. Those call sites are not rewritten automatically.` })
      }
    }
  }
  for (const handle of exportedHandles) {
    followUps.push({
      file,
      line: block.lineOffset + line(handle),
      message: handles.get(handle) === "gateway"
        ? `\`${handle.name}\` is an exported gateway. In other files, read \`.ask()\` as \`[error, answers]\`. Those call sites are not rewritten automatically.`
        : `\`${handle.name}\` is an exported Workflow handle. In other files, read \`.start()\`, \`.getRun()\`, and \`.cancel()\` as \`[error, data]\`. Those call sites are not rewritten automatically.`,
    })
  }
  const handler = route ? directRouteHandler(program) : undefined
  let responseHelper: string | undefined
  const match = (call: CallExpression, ancestors: readonly Node[]): ResultCall | undefined => {
    const callee = call.callee
    const name = exportedName(callee)
    const result = name ? resultFunctions.get(name) : undefined
    if (result?.returnedResponse) {
      const unbound = callee.type === "Identifier" && !resolveBinding(callee)
      const parent = ancestors.at(-1)
      const returned = parent?.type === "AwaitExpression" ? ancestors.at(-2) : parent
      if (!unbound && handler && returned?.type === "ReturnStatement" && enclosingFunction(ancestors) === handler) {
        return { error: "error", value: result.value, responseHelper: freeName => responseHelper ??= freeName("toResponse") }
      }
      if (!readsTuple(call, program)) followUps.push({ file, line: block.lineOffset + line(call), message: responseFollowUp(calleeText(call, block.code), unbound) })
      return undefined
    }
    if (result) return { error: "error", errorAfterValue: true, value: result.value }
    if (callee.type !== "MemberExpression") return undefined
    const property = memberName(callee)
    const kind = property ? handleKind(callee.object) : undefined
    const method = kind && property ? handleMethods[kind].get(property) : undefined
    return method ? { error: "error", errorAfterValue: true, value: method } : undefined
  }
  const rewritten = rewriteResultCalls(context, match, (call) => {
    const callee = calleeText(call, block.code)
    const name = exportedName(call.callee)
    followUps.push({
      file,
      line: block.lineOffset + line(call),
      message: name && resultFunctions.get(name)?.returnedResponse ? responseFollowUp(callee) : `\`${callee}()\` returns \`[error, data]\` now. It no longer throws on a runtime failure, such as a provider or store failure or an input that is not valid. Read the error first: \`const [error, data] = await ${callee}(...)\`, then \`if (error) throw error\`.`,
    })
  })
  if (responseHelper) {
    const { output, style } = context
    const lastImport = program.program.body.findLast(statement => statement.type === "ImportDeclaration")
    if (lastImport) {
      const specifier = responseHelper === "toResponse" ? "toResponse" : `toResponse as ${responseHelper}`
      output.appendLeft(block.offset + end(lastImport), `\nimport { ${specifier} } from ${quoteString("vite-hub/runtime", style)}${style.semicolons ? ";" : ""}`)
    }
  }
  return rewritten
}

function responseFollowUp(callee: string, unbound = false): string {
  const read = unbound ? `Confirm that this auto-import comes from ViteHub before changing \`${callee}()\`. If it does, the call` : `\`${callee}()\``
  return `${read} returns \`[error, data]\` now, not a \`Response\`. Read \`const [error, data] = await ${callee}(...)\`. Keep the HTTP response with \`toResponse(error ?? data)\` from \`vite-hub/runtime\`, or handle the error and use \`data\` directly.`
}

/** A default-exported handler, either bare or passed directly to a known H3 or Nitro wrapper. */
function directRouteHandler(program: File): Node | undefined {
  const declaration = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")?.declaration
  if (!declaration) return undefined
  if (declaration.type === "FunctionDeclaration" || declaration.type === "FunctionExpression" || declaration.type === "ArrowFunctionExpression") return declaration
  if (declaration.type !== "CallExpression" || declaration.callee.type !== "Identifier" || declaration.arguments.length !== 1) return undefined
  const [handler] = declaration.arguments
  if (handler?.type !== "ArrowFunctionExpression" && handler?.type !== "FunctionExpression") return undefined
  const name = declaration.callee.name
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !["h3", "nitro"].includes(statement.source.value)) continue
    if (statement.specifiers.some(specifier => specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && specifier.local.name === name && importedName(specifier) === "defineEventHandler")) return handler
  }
}

/** Whether the code already reads the call as a Result, as in `const [error, data] = await runBrowser(...)`. */
function readsTuple(call: CallExpression, program: File): boolean {
  let found = false
  walk(program, (node) => {
    if (found) return
    const read = node.type === "VariableDeclarator" && node.id.type === "ArrayPattern" ? node.init : node.type === "AssignmentExpression" && node.left.type === "ArrayPattern" ? node.right : undefined
    if (read && (read === call || (read.type === "AwaitExpression" && read.argument === call))) found = true
  })
  return found
}

function memberName(node: Extract<Node, { type: "MemberExpression" }>): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if (node.computed && node.property.type === "StringLiteral") return node.property.value
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { edits, followUps, rewritten } = await plan(cwd)
  return {
    summary: rewritten ? `read ${rewritten} call(s) as \`[error, data]\` in ${edits.length} file(s)` : "found no call to read as a Result",
    edits,
    followUps,
    notes: rewritten ? ["Rewritten calls throw their errors or, for former Response calls in routes, return them with `toResponse()`."] : [],
    nextSteps: edits.length ? ["Run your typecheck."] : [],
  }
}

async function plan(cwd: string): Promise<{ edits: FileEdit[], followUps: FollowUp[], rewritten: number }> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let rewritten = 0

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (!needles.some(needle => source.includes(needle))) continue
    const output = new MagicString(source)
    const autoImports = /(?:^|\/)server\//.test(file)
    const route = /^server\/(?:api|routes)\//.test(file) && !file.endsWith(".vue")
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Read the Results of its calls by hand.` })
        continue
      }
      rewritten += migrateBlock({ autoImports, block, file, followUps, output, program, route, style: detectStyle(block.code, program) })
    }
    if (output.hasChanged()) edits.push({ path: file, before: source, after: output.toString() })
  }

  return { edits, followUps, rewritten }
}

export const resultTuples: Codemod = {
  name: "result-tuples",
  description: "Read the Workflow calls and handle methods, runSchedule(), listAuthEvents(), aggregateAuthEvents(), runBrowser(), runBrowserContent(), runSandboxTask(), and gateway ask() as `[error, data]` Results",
  usage: "[dir]",
  detectAfterEdits: true,
  async detect({ cwd }) {
    const { edits, followUps } = await plan(cwd)
    if (edits.length) return { reason: `${edits[0]!.path} reads a call that returns \`[error, data]\` now` }
    if (followUps.length) return { reason: `${followUps[0]!.file} has Result calls to check by hand` }
    return undefined
  },
  run: migrate,
}
