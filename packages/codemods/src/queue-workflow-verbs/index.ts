import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, isReference, keyName, line, listItemRemoval, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import type { CallExpression, File, ImportDeclaration, ImportSpecifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, Detection, FileEdit, FollowUp } from "../types.ts"

type Primitive = "queue" | "workflow"

const primitiveModules = new Map<string, Primitive>([
  ["vite-hub/queue", "queue"],
  ["@vite-hub/queue", "queue"],
  ["vite-hub/workflow", "workflow"],
  ["@vite-hub/workflow", "workflow"],
])

/** Exports that have a new name. */
const renamedExports: Record<Primitive, ReadonlyMap<string, string>> = {
  queue: new Map([
    ["runQueue", "sendQueue"],
    ["getQueue", "useQueue"],
  ]),
  workflow: new Map([
    ["runWorkflow", "startWorkflow"],
    ["resumeWorkflowSignal", "resumeWorkflow"],
    ["WorkflowDeferOptions", "WorkflowStartOptions"],
  ]),
}
const oldNames = new Map([...renamedExports.queue, ...renamedExports.workflow])

/** `dynamicQueue.run()` and `dynamicQueue.get()`. */
const dynamicQueueMethods = new Map([["run", "send"], ["get", "use"]])

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
  /** Nodes that the codemod already rewrote or reported. */
  handled: Set<Node>
  /** Number of `deferWorkflow()` calls whose result the code reads. */
  readDefers: number
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: context.block.lineOffset + line(node), message })
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(context.block.offset + start(node), context.block.offset + end(node), text)
  context.handled.add(node)
}

function importedName(specifier: ImportSpecifier): string {
  return specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
}

/** Names of `names` that a function, class, variable, parameter, or catch clause declares in `program`. */
function localDeclarations(program: File, names: ReadonlySet<string>): Set<string> {
  const declared = new Set<string>()
  const addPattern = (pattern: Node | null | undefined) => {
    if (!pattern) return
    if (pattern.type === "Identifier") {
      if (names.has(pattern.name)) declared.add(pattern.name)
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
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" || node.type === "ClassMethod") {
      if ("id" in node) addPattern(node.id)
      node.params.forEach(addPattern)
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") addPattern(node.id)
  })
  return declared
}

/** The local names that a block gives to the Queue and Workflow exports. */
interface Bindings {
  /** Old local name to new name, for references in this block. */
  renamed: Map<string, string>
  /** Namespace imports, such as `import * as queue from "vite-hub/queue"`. */
  namespaces: Map<string, Primitive>
  dynamicQueue: Set<string>
  createWorkflow: Set<string>
  deferWorkflow: Set<string>
  /** The local name of `startWorkflow`, when the block imports it. */
  startWorkflow?: string
  /** The import declaration that holds `deferWorkflow`. */
  deferImport?: { statement: ImportDeclaration, specifier: ImportSpecifier }
}

function rewriteImports(context: FileContext): Bindings {
  const { program } = context
  const bindings: Bindings = { renamed: new Map(), namespaces: new Map(), dynamicQueue: new Set(), createWorkflow: new Set(), deferWorkflow: new Set() }
  /** Local names that an import of a Queue or Workflow module binds. */
  const imported = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !primitiveModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) imported.add(specifier.local.name)
  }

  const renamable = new Set<string>()
  const pending: Array<{ specifier: ImportSpecifier, to: string }> = []
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    const primitive = primitiveModules.get(statement.source.value)
    if (!primitive) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        bindings.namespaces.set(specifier.local.name, primitive)
        continue
      }
      if (specifier.type !== "ImportSpecifier") continue
      const name = importedName(specifier)
      const local = specifier.local.name
      if (name === "dynamicQueue") bindings.dynamicQueue.add(local)
      if (name === "createWorkflow") bindings.createWorkflow.add(local)
      if (name === "startWorkflow") bindings.startWorkflow = local
      if (name === "deferWorkflow") {
        bindings.deferWorkflow.add(local)
        bindings.deferImport = { statement, specifier }
      }
      const to = renamedExports[primitive].get(name)
      if (!to) continue
      pending.push({ specifier, to })
      if (local === name) renamable.add(local)
    }
  }

  // A local declaration with the same name, such as a parameter, can shadow the import. The codemod has no scope
  // analysis, so it keeps the old local name for that block: `import { sendQueue as runQueue }`.
  const shadowed = localDeclarations(program, renamable)
  for (const { specifier, to } of pending) {
    const name = importedName(specifier)
    const local = specifier.local.name
    if (local !== name) {
      overwrite(context, specifier.imported, to)
      continue
    }
    if (shadowed.has(local)) {
      overwrite(context, specifier, `${to} as ${local}`)
      followUp(context, specifier, `\`${local}\` is also declared in this file, so the codemod imports \`${to}\` as \`${local}\`. Rename the calls to \`${to}\` by hand.`)
      continue
    }
    if (to === "startWorkflow" && bindings.startWorkflow) {
      // The block imports both names. Calls move to the existing `startWorkflow` binding.
      bindings.renamed.set(local, bindings.startWorkflow)
      const [from, until] = listItemRemoval(context.block.code, specifier)
      context.output.remove(context.block.offset + from, context.block.offset + until)
      context.handled.add(specifier)
      continue
    }
    if (imported.has(to)) {
      bindings.renamed.set(local, to)
      const [from, until] = listItemRemoval(context.block.code, specifier)
      context.output.remove(context.block.offset + from, context.block.offset + until)
      context.handled.add(specifier)
      continue
    }
    overwrite(context, specifier, to)
    bindings.renamed.set(local, to)
    if (to === "startWorkflow") bindings.startWorkflow = to
  }

  // A barrel such as `export { runQueue } from "vite-hub/queue"` re-exports the new name.
  for (const statement of program.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.source) continue
    const primitive = primitiveModules.get(statement.source.value)
    if (!primitive) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier") continue
      const name = keyName(specifier.local)
      const to = name ? renamedExports[primitive].get(name) : undefined
      if (!to) continue
      if (start(specifier.local) === start(specifier.exported)) overwrite(context, specifier, to)
      else overwrite(context, specifier.local, to)
    }
  }
  return bindings
}

/** True when the code reads the value of `node`: it is not a statement, a `void` operand, or an awaited statement. */
function valueIsRead(node: Node, ancestors: readonly Node[]): boolean {
  let child = node
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!
    if (parent.type === "AwaitExpression" || parent.type === "TSAsExpression" || parent.type === "TSNonNullExpression" || parent.type === "ParenthesizedExpression") {
      child = parent
      continue
    }
    if (parent.type === "ExpressionStatement") return false
    if (parent.type === "UnaryExpression" && parent.operator === "void") return false
    // The body of an arrow function such as `() => deferWorkflow(...)` is its result.
    return !(parent.type === "SequenceExpression" && parent.expressions.at(-1) !== child)
  }
  return true
}

/** Removes the `await` before a call that now returns nothing, when the await is a whole statement. */
function removeStatementAwait(context: FileContext, call: Node, ancestors: readonly Node[]) {
  const parent = ancestors.at(-1)
  const statement = ancestors.at(-2)
  if (parent?.type !== "AwaitExpression" || parent.argument !== call || statement?.type !== "ExpressionStatement") return
  context.output.remove(context.block.offset + start(parent), context.block.offset + start(call))
}

function memberProperty(node: Node): { object: Node, name: string, property: Node } | undefined {
  if ((node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") || node.computed || node.property.type !== "Identifier") return
  return { object: node.object, name: node.property.name, property: node.property }
}

function isCreateWorkflowCall(node: Node | null | undefined, bindings: Bindings): node is CallExpression {
  if (node?.type !== "CallExpression") return false
  const callee = node.callee
  if (callee.type === "Identifier") return bindings.createWorkflow.has(callee.name)
  const member = memberProperty(callee)
  return Boolean(member && member.name === "createWorkflow" && member.object.type === "Identifier" && bindings.namespaces.get(member.object.name) === "workflow")
}

/** Names of variables that hold a Workflow handle from `createWorkflow()`. */
function workflowHandles(context: FileContext, bindings: Bindings): Set<string> {
  const handles = new Set<string>()
  walk(context.program, (node, ancestors) => {
    if (node.type !== "VariableDeclarator" || !isCreateWorkflowCall(node.init, bindings)) return
    if (node.id.type === "Identifier") {
      handles.add(node.id.name)
      const exported = ancestors.at(-2)?.type === "ExportNamedDeclaration"
      if (exported) followUp(context, node, `\`${node.id.name}\` is a Workflow handle that this file exports. Rename \`.run()\` to \`.start()\` where other files call it.`)
      return
    }
    followUp(context, node, "This destructures a Workflow handle. Its `run` method is now `start`, and `defer` returns nothing.")
  })
  walk(context.program, (node) => {
    if (node.type === "ExportDefaultDeclaration" && isCreateWorkflowCall(node.declaration, bindings)) {
      followUp(context, node, "This file exports a Workflow handle. Rename `.run()` to `.start()` where other files call it.")
    }
  })
  return handles
}

function rewriteReferences(context: FileContext, bindings: Bindings) {
  const { program } = context
  const handles = workflowHandles(context, bindings)
  const isHandle = (node: Node) => (node.type === "Identifier" && handles.has(node.name)) || isCreateWorkflowCall(node, bindings)
  const isDynamicQueue = (node: Node) => {
    if (node.type === "Identifier") return bindings.dynamicQueue.has(node.name)
    const member = memberProperty(node)
    return Boolean(member && member.name === "dynamicQueue" && member.object.type === "Identifier" && bindings.namespaces.get(member.object.name) === "queue")
  }
  const isDeferWorkflow = (node: Node) => {
    if (node.type === "Identifier") return bindings.deferWorkflow.has(node.name)
    const member = memberProperty(node)
    return Boolean(member && member.name === "deferWorkflow" && member.object.type === "Identifier" && bindings.namespaces.get(member.object.name) === "workflow")
  }

  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)

    if (node.type === "Identifier" && bindings.renamed.has(node.name) && !context.handled.has(node) && isReference(node, parent)) {
      const to = bindings.renamed.get(node.name)!
      // `{ runQueue }` keeps its key, and `export { runQueue }` keeps its exported name.
      if (parent?.type === "ObjectProperty" && parent.shorthand) overwrite(context, node, `${node.name}: ${to}`)
      else if (parent?.type === "ExportSpecifier" && start(parent.exported) === start(node)) overwrite(context, node, `${to} as ${node.name}`)
      else overwrite(context, node, to)
      return
    }

    const member = memberProperty(node)
    if (member) {
      const namespace = member.object.type === "Identifier" ? bindings.namespaces.get(member.object.name) : undefined
      const renamed = namespace ? renamedExports[namespace].get(member.name) : undefined
      if (renamed) {
        overwrite(context, member.property, renamed)
        return
      }
      const method = dynamicQueueMethods.get(member.name)
      if (method && isDynamicQueue(member.object)) {
        overwrite(context, member.property, method)
        return
      }
      if (member.name === "run" && isHandle(member.object)) {
        overwrite(context, member.property, "start")
        return
      }
    }

    if (node.type !== "CallExpression") return
    const callee = node.callee
    const handleDefer = memberProperty(callee)
    const deferCall = isDeferWorkflow(callee) || Boolean(handleDefer && handleDefer.name === "defer" && isHandle(handleDefer.object))
    if (!deferCall) return
    if (!valueIsRead(node, ancestors)) {
      removeStatementAwait(context, node, ancestors)
      return
    }
    // The code reads the run, so it needs `startWorkflow()`, which returns it, as `deferWorkflow()` did before.
    if (handleDefer && handleDefer.name === "defer") {
      overwrite(context, handleDefer.property, "start")
      return
    }
    if (callee.type === "Identifier") {
      overwrite(context, callee, bindings.startWorkflow ?? "startWorkflow")
      context.readDefers++
    }
    else if (handleDefer) {
      overwrite(context, handleDefer.property, "startWorkflow")
    }
  })

  // `deferWorkflow()` calls that now use `startWorkflow()` need the import.
  if (context.readDefers && !bindings.startWorkflow && bindings.deferImport) {
    const { specifier } = bindings.deferImport
    const remaining = countDeferReferences(context, bindings)
    if (remaining === 0 && specifier.local.name === importedName(specifier)) {
      overwrite(context, specifier, "startWorkflow")
    }
    else {
      context.output.appendLeft(context.block.offset + end(specifier), ", startWorkflow")
    }
  }
}

/** References to `deferWorkflow` that the codemod did not rewrite. */
function countDeferReferences(context: FileContext, bindings: Bindings): number {
  let count = 0
  walk(context.program, (node, ancestors) => {
    if (node.type === "Identifier" && bindings.deferWorkflow.has(node.name) && !context.handled.has(node) && isReference(node, ancestors.at(-1))) count++
  })
  return count
}

/** Old names that are left, for example in a mock or a string. */
function reportLeftovers(context: FileContext) {
  walk(context.program, (node, ancestors) => {
    if (context.handled.has(node)) return
    const parent = ancestors.at(-1)
    if (parent && context.handled.has(parent)) return
    let name: string | undefined
    if (node.type === "StringLiteral") name = node.value
    // A local variable or parameter with an old name is the app's own. A property such as `mod.runQueue` reads the export.
    else if (node.type === "Identifier" && parent && memberProperty(parent)?.property === node) name = node.name
    // `{ runQueue: sendQueue }` keeps the key of a shorthand property on purpose.
    else if ((node.type === "ObjectProperty" || node.type === "ObjectMethod") && !node.computed && !(node.type === "ObjectProperty" && node.shorthand && context.handled.has(node.value))) name = keyName(node.key)
    const to = name ? oldNames.get(name) : undefined
    if (!name || !to) return
    followUp(context, node, `This still names \`${name}\`, for example in a mock or a string. The export is now \`${to}\`.`)
  })
}

function rewriteBlock(context: FileContext): boolean {
  const before = context.output.toString()
  const bindings = rewriteImports(context)
  rewriteReferences(context, bindings)
  reportLeftovers(context)
  return context.output.toString() !== before
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  let readDefers = 0

  for (const file of files) {
    const source = await readFile(join(cwd, file), "utf8")
    if (![...primitiveModules.keys()].some(module => source.includes(module))) continue
    const output = new MagicString(source)
    let changed = false
    for (const block of scriptBlocks(file, source)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch (error) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename the Queue and Workflow verbs by hand.` })
        continue
      }
      const context: FileContext = { block, file, followUps, handled: new Set(), output, program, readDefers: 0 }
      if (rewriteBlock(context)) changed = true
      readDefers += context.readDefers
    }
    if (changed) edits.push({ path: file, before: source, after: output.toString() })
  }

  const notes = [
    "`deferQueue()`, `deferWorkflow()`, and the `defer()` method of a Workflow handle return nothing. A failure goes to the log.",
    ...(readDefers ? [`${readDefers} \`deferWorkflow()\` call(s) read the run, so they now call \`startWorkflow()\`, which returns it.`] : []),
  ]
  return {
    summary: edits.length ? `renamed the Queue and Workflow verbs in ${edits.length} file(s)` : "found no Queue or Workflow verb to rename",
    edits,
    followUps,
    notes: edits.length ? notes : [],
    nextSteps: edits.length ? ["Run your typecheck. It finds the Workflow handle calls in files that import a handle from another file."] : [],
  }
}

/** Names that only the old API has. A migrated app still uses `deferWorkflow` and `dynamicQueue`. */
const oldVerbPattern = /\b(?:runQueue|getQueue|runWorkflow|resumeWorkflowSignal|WorkflowDeferOptions|dynamicQueue\.(?:run|get))\b/

async function detect({ cwd }: CodemodContext): Promise<Detection | undefined> {
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()) {
    const source = await readFile(join(cwd, file), "utf8")
    if (![...primitiveModules.keys()].some(module => source.includes(module))) continue
    const name = oldVerbPattern.exec(source)?.[0]
    if (name) return { reason: `${file} uses \`${name}\`` }
  }
  return undefined
}

export const queueWorkflowVerbs: Codemod = {
  name: "queue-workflow-verbs",
  description: "Rename runQueue, getQueue, runWorkflow, and resumeWorkflowSignal, and read deferred Workflow runs with startWorkflow",
  usage: "[dir]",
  detect,
  run: migrate,
}
