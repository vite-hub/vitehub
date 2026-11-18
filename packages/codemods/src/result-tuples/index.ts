import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { rewriteResultCalls, scriptBlocks } from "../shared/result-calls.ts"

import type { CallExpression, File, Identifier, ImportDeclaration } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { ResultCall, ResultCallContext } from "../shared/result-calls.ts"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

/** Functions that return `[error, data]` now and threw before, with the name of their value. */
const resultFunctions = new Map([
  ["startWorkflow", "run"],
  ["getWorkflowRun", "run"],
  ["cancelWorkflow", "run"],
  ["resumeWorkflow", "signal"],
])
/** Methods of a `createWorkflow()` handle that return `[error, data]` now. */
const handleMethods = new Map([
  ["start", "run"],
  ["getRun", "run"],
  ["cancel", "run"],
])
const modules = new Set(["vite-hub/workflow", "@vite-hub/workflow"])
const needles = [...resultFunctions.keys(), "createWorkflow"]

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  if (specifier.type !== "ImportSpecifier") return undefined
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/** Local bindings of the Workflow imports in this block, by their exported name. */
function workflowImports(program: File): Map<Identifier, string> {
  const bindings = new Map<Identifier, string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !modules.has(statement.source.value) || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") bindings.set(specifier.local, "*")
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const name = importedName(specifier)
      if (name && (resultFunctions.has(name) || name === "createWorkflow")) bindings.set(specifier.local, name)
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
  /** Nuxt auto-imports the Workflow helpers in server code, so a name that the file does not declare counts there. */
  autoImports: boolean
}

function migrateBlock(context: BlockContext): number {
  const { autoImports, block, file, followUps, program } = context
  const imports = workflowImports(program)
  if (!imports.size && !autoImports) return 0
  const resolveBinding = bindingResolver(program)
  const exportedName = (node: Node): string | undefined => {
    if (node.type === "MemberExpression" && node.object.type === "Identifier") {
      const binding = resolveBinding(node.object)
      return binding && imports.get(binding) === "*" ? memberName(node) : undefined
    }
    if (node.type !== "Identifier") return undefined
    const binding = resolveBinding(node)
    if (binding) return imports.get(binding)
    return autoImports && (resultFunctions.has(node.name) || node.name === "createWorkflow") ? node.name : undefined
  }
  // `const onboard = createWorkflow(...)` makes `onboard` a handle.
  const handles = new Set<Identifier>()
  const isHandle = (node: Node): boolean => {
    if (node.type === "CallExpression") return exportedName(node.callee) === "createWorkflow"
    if (node.type !== "Identifier") return false
    const binding = resolveBinding(node)
    return binding !== undefined && handles.has(binding)
  }
  let previousSize: number
  do {
    previousSize = handles.size
    walk(program, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isHandle(node.init)) handles.add(node.id)
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
    else if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type === "Identifier") addExport(statement.declaration)
  }
  for (const handle of exportedHandles) {
    followUps.push({
      file,
      line: block.lineOffset + line(handle),
      message: `\`${handle.name}\` is an exported Workflow handle. In other files, read \`.start()\`, \`.getRun()\`, and \`.cancel()\` as \`[error, data]\`. Those call sites are not rewritten automatically.`,
    })
  }
  const match = (call: CallExpression): ResultCall | undefined => {
    const callee = call.callee
    const name = exportedName(callee)
    const value = name ? resultFunctions.get(name) : undefined
    if (value) return { error: "error", errorAfterValue: true, value }
    if (callee.type !== "MemberExpression") return undefined
    const property = memberName(callee)
    const method = property && isHandle(callee.object) ? handleMethods.get(property) : undefined
    return method ? { error: "error", errorAfterValue: true, value: method } : undefined
  }
  return rewriteResultCalls(context, match, (call) => {
    const callee = calleeText(call, block.code)
    followUps.push({
      file,
      line: block.lineOffset + line(call),
      message: `\`${callee}()\` returns \`[error, data]\` now. It no longer throws when the Workflow provider fails, an option is not supported, or the input is not valid. Read the error first: \`const [error, data] = await ${callee}(...)\`, then \`if (error) throw error\`.`,
    })
  })
}

function memberName(node: Extract<Node, { type: "MemberExpression" }>): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if (node.computed && node.property.type === "StringLiteral") return node.property.value
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const { edits, followUps, rewritten } = await plan(cwd)
  return {
    summary: rewritten ? `read ${rewritten} Workflow call(s) as \`[error, data]\` in ${edits.length} file(s)` : "found no Workflow call to read as a Result",
    edits,
    followUps,
    notes: rewritten ? ["Each rewritten call throws its error, as the call did before. Return the error to the client, or handle it, where that is better."] : [],
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
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Read the Workflow results by hand.` })
        continue
      }
      rewritten += migrateBlock({ autoImports, block, file, followUps, output, program, style: detectStyle(block.code, program) })
    }
    if (output.hasChanged()) edits.push({ path: file, before: source, after: output.toString() })
  }

  return { edits, followUps, rewritten }
}

export const resultTuples: Codemod = {
  name: "result-tuples",
  description: "Read startWorkflow(), getWorkflowRun(), cancelWorkflow(), resumeWorkflow(), and the Workflow handle methods as `[error, data]` Results",
  usage: "[dir]",
  detectAfterEdits: true,
  async detect({ cwd }) {
    const { edits, followUps } = await plan(cwd)
    if (edits.length) return { reason: `${edits[0]!.path} reads a Workflow call that returns \`[error, data]\` now` }
    if (followUps.length) return { reason: `${followUps[0]!.file} has Workflow Result calls to check by hand` }
    return undefined
  },
  run: migrate,
}
