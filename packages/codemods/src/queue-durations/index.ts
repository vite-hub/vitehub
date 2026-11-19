import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { detectStyle, end, keyName, line, parseProgram, quoteString, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"

import type { CallExpression, File, Identifier, ObjectExpression, ObjectProperty, StringLiteral } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const queueModules = new Set(["vite-hub/queue", "@vite-hub/queue"])

/**
 * Queue exports by what they do. The old verbs are here too: `vitehub migrate` detects every codemod before
 * `queue-workflow-verbs` renames them.
 */
const sendFunctions = new Set(["deferQueue", "runQueue", "sendQueue"])
const clientFunctions = new Set(["createQueueClient", "getQueue", "useQueue"])
const dynamicSendMethods = new Set(["defer", "run", "send"])
const dynamicClientMethods = new Set(["get", "use"])

/** Nuxt auto-imports these in server code, so a file can call them without an import. */
const autoImports = new Set(["defineQueue", "deferQueue", "sendQueue", "useQueue"])

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const needle = /\b(?:delaySeconds|retentionSeconds)\b/

const renamed: Readonly<Record<string, string>> = { delaySeconds: "delay", retentionSeconds: "retention" }

interface FileContext {
  code: string
  file: string
  followUps: FollowUp[]
  output: MagicString
  program: File
  resolve: (node: Identifier) => Identifier | undefined
  /** The exported name of each Queue import, by its local identifier. `undefined` for a namespace import. */
  imports: Map<Identifier, string | undefined>
  /** Variables that hold a Queue client, such as `const queue = await useQueue("welcome")`. */
  clients: Set<Identifier>
  /** Properties and calls that the codemod rewrote or must keep. */
  handled: Set<Node>
  style: CodeStyle
  changed: number
}

function overwrite(context: FileContext, node: Node, text: string) {
  context.output.overwrite(start(node), end(node), text)
  context.changed++
}

function followUp(context: FileContext, node: Node, message: string) {
  context.followUps.push({ file: context.file, line: line(node), message })
}

function collectImports(program: File): Map<Identifier, string | undefined> {
  const imports = new Map<Identifier, string | undefined>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || !queueModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") imports.set(specifier.local, undefined)
      else if (specifier.type === "ImportSpecifier") imports.set(specifier.local, keyName(specifier.imported))
    }
  }
  return imports
}

function unwrap(node: Node | null | undefined): Node | null | undefined {
  let current = node
  while (current && (current.type === "AwaitExpression" || current.type === "TSAsExpression" || current.type === "TSNonNullExpression" || current.type === "ParenthesizedExpression" || current.type === "TSSatisfiesExpression")) {
    current = current.type === "AwaitExpression" ? current.argument : current.expression
  }
  return current
}

/** The Queue export that `node` names: an imported or auto-imported function, or a property of a namespace import. */
function queueExport(context: FileContext, node: Node): string | undefined {
  if (node.type === "Identifier") {
    const binding = context.resolve(node)
    if (!binding) return autoImports.has(node.name) ? node.name : undefined
    return context.imports.get(binding)
  }
  if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed && node.object.type === "Identifier") {
    const binding = context.resolve(node.object)
    if (binding && context.imports.has(binding) && context.imports.get(binding) === undefined) return keyName(node.property)
  }
  return undefined
}

/** `dynamicQueue.<method>`, through an import or a namespace import. */
function dynamicQueueMethod(context: FileContext, callee: Node): string | undefined {
  if ((callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") || callee.computed) return undefined
  return queueExport(context, callee.object) === "dynamicQueue" ? keyName(callee.property) : undefined
}

function isClientCall(context: FileContext, node: Node | null | undefined): boolean {
  const call = unwrap(node)
  if (call?.type !== "CallExpression") return false
  const name = queueExport(context, call.callee)
  if (name && clientFunctions.has(name)) return true
  const method = dynamicQueueMethod(context, call.callee)
  return Boolean(method && dynamicClientMethods.has(method))
}

function isClient(context: FileContext, node: Node): boolean {
  if (isClientCall(context, node)) return true
  const value = unwrap(node)
  if (value?.type !== "Identifier") return false
  const binding = context.resolve(value)
  return Boolean(binding && context.clients.has(binding))
}

/** Variables whose value is a Queue client. Revisits declarations so simple alias chains work in either order. */
function collectClients(context: FileContext) {
  let added = true
  while (added) {
    added = false
    walk(context.program, (node) => {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || context.clients.has(node.id) || !node.init) return
      if (!isClient(context, node.init)) return
      context.clients.add(node.id)
      added = true
    })
  }
}

/** The value of a number literal or of arithmetic on number literals, such as `24 * 60 * 60`. */
function constantNumber(node: Node): number | undefined {
  const value = unwrap(node)
  if (!value) return undefined
  if (value.type === "NumericLiteral") return value.value
  if (value.type === "UnaryExpression" && value.operator === "+") return constantNumber(value.argument)
  if (value.type !== "BinaryExpression" || value.left.type === "PrivateName") return undefined
  const left = constantNumber(value.left)
  const right = constantNumber(value.right)
  if (left === undefined || right === undefined) return undefined
  if (value.operator === "+") return left + right
  if (value.operator === "-") return left - right
  if (value.operator === "*") return left * right
  if (value.operator === "/") return left / right
  return undefined
}

/** True for code that always gives a number: arithmetic other than `+`, a sign, or a `Math` or `Number` call. */
function isNumberExpression(context: FileContext, node: Node): boolean {
  const value = unwrap(node)
  if (!value) return false
  if (value.type === "BinaryExpression") return ["-", "*", "/", "%", "**"].includes(value.operator)
  if (value.type === "UnaryExpression") return value.operator === "-" || value.operator === "+"
  if (value.type !== "CallExpression") return false
  const { callee } = value
  if (callee.type === "Identifier") return ["Number", "parseFloat", "parseInt"].includes(callee.name) && !context.resolve(callee)
  return callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === "Math" && !context.resolve(callee.object)
}

function isUndefined(context: FileContext, node: Node): boolean {
  return node.type === "Identifier" && node.name === "undefined" && !context.resolve(node)
}

function oldKey(property: ObjectExpression["properties"][number]): property is ObjectProperty & { key: Identifier | StringLiteral } {
  return property.type === "ObjectProperty" && !property.computed && (property.key.type === "Identifier" || property.key.type === "StringLiteral")
    && Object.hasOwn(renamed, keyName(property.key) ?? "")
}

/** Renames `delaySeconds` to `delay` and `retentionSeconds` to `retention` in one options object of a Queue call. */
function rewriteOptions(context: FileContext, options: Node | null | undefined) {
  const object = unwrap(options)
  if (object?.type !== "ObjectExpression") return
  for (const property of object.properties) {
    if (!oldKey(property) || context.handled.has(property)) continue
    context.handled.add(property)
    const from = keyName(property.key)!
    const to = renamed[from]!
    // `{ "delaySeconds": 60 }` keeps its quotes, so the key stays a string.
    const key = property.key.type === "StringLiteral" ? quoteString(to, { quote: context.code[start(property.key)] === "'" ? "'" : "\"" }) : to
    const valueCode = context.code.slice(start(property.value), end(property.value))
    if (to === "retention") {
      // A lifetime still takes a number of seconds, so the value stays.
      overwrite(context, property, property.shorthand ? `${key}: ${valueCode}` : `${key}${context.code.slice(end(property.key), end(property))}`)
      continue
    }
    if (isUndefined(context, property.value)) {
      overwrite(context, property.key, key)
      continue
    }
    const seconds = constantNumber(property.value)
    const text = seconds === undefined ? undefined : String(seconds)
    if (text !== undefined && /^\d+(?:\.\d+)?$/.test(text)) {
      overwrite(context, property, `${key}: ${quoteString(`${text}s`, context.style)}`)
      continue
    }
    if (isNumberExpression(context, property.value)) {
      // The same number of seconds, as a duration string.
      overwrite(context, property, `${key}: \`\${${valueCode}}s\``)
      continue
    }
    overwrite(context, property, property.shorthand ? `${key}: ${valueCode}` : `${key}${context.code.slice(end(property.key), end(property))}`)
    followUp(context, property, `Queue \`delay\` takes a duration string, such as "60s", in place of a number of seconds. The codemod cannot read \`${valueCode}\`, so write it as a duration, for example \`\${${valueCode}}s\` when it is a number of seconds.`)
  }
}

/**
 * `{ retry: { delaySeconds: 30 } }` that `onError` of `defineQueue()` returns. The options are the first argument, or
 * the second in the old `defineQueue(handler, options)` form, which `define-forms` moves.
 */
function rewriteRetryActions(context: FileContext, definition: CallExpression) {
  for (const argument of definition.arguments.slice(0, 2)) {
    const options = unwrap(argument)
    if (options?.type === "ObjectExpression") rewriteOnError(context, options)
  }
}

function rewriteOnError(context: FileContext, options: ObjectExpression) {
  for (const property of options.properties) {
    if ((property.type !== "ObjectProperty" && property.type !== "ObjectMethod") || property.computed || keyName(property.key) !== "onError") continue
    walk(property, (node) => {
      if (node.type !== "ObjectExpression") return
      for (const action of node.properties) {
        if (action.type === "ObjectProperty" && !action.computed && keyName(action.key) === "retry") rewriteOptions(context, action.value)
      }
    })
  }
}

function rewriteCalls(context: FileContext) {
  walk(context.program, (node) => {
    if (node.type !== "CallExpression") return
    const { callee } = node
    const name = queueExport(context, callee)
    if (name && sendFunctions.has(name)) return rewriteOptions(context, node.arguments[2])
    if (name === "defineQueue") return rewriteRetryActions(context, node)
    const method = dynamicQueueMethod(context, callee)
    if (method && dynamicSendMethods.has(method)) return rewriteOptions(context, node.arguments[2])
    if ((callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") || callee.computed || !isClient(context, callee.object)) return
    const clientMethod = keyName(callee.property)
    if (clientMethod === "send") rewriteOptions(context, node.arguments[1])
    if (clientMethod !== "sendBatch") return
    const items = unwrap(node.arguments[0])
    if (items?.type === "ArrayExpression") {
      for (const item of items.elements) if (item) rewriteOptions(context, item)
    }
    rewriteOptions(context, node.arguments[1])
  })
}

/** The native Cloudflare `message.retry()` and `batch.retryAll()` keep `delaySeconds`. */
function keepNativeRetries(context: FileContext) {
  walk(context.program, (node) => {
    if (node.type !== "CallExpression" || (node.callee.type !== "MemberExpression" && node.callee.type !== "OptionalMemberExpression") || node.callee.computed) return
    const method = keyName(node.callee.property)
    if (method !== "retry" && method !== "retryAll") return
    const options = unwrap(node.arguments[0])
    if (options?.type === "ObjectExpression") for (const property of options.properties) context.handled.add(property)
  })
}

/** Old names that are left, such as options built in a variable or read from an object. */
function reportLeftovers(context: FileContext) {
  walk(context.program, (node, ancestors) => {
    if (context.handled.has(node)) return
    let key: Node | undefined
    if ((node.type === "ObjectProperty" || node.type === "TSPropertySignature") && !node.computed) key = node.key
    else if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && !node.computed) key = node.property
    const name = key ? keyName(key) : undefined
    if (!name || !Object.hasOwn(renamed, name)) return
    // A destructured `{ delaySeconds }` names a local value, not a Queue option.
    if (node.type === "ObjectProperty" && ancestors.at(-1)?.type === "ObjectPattern") return
    followUp(context, node, `This still names \`${name}\`. If it is a ViteHub Queue option, rename it to \`${renamed[name]}\` and write ${name === "delaySeconds" ? "a duration string such as \"60s\"" : "a duration such as \"1h\" or a number of seconds"}. Cloudflare's native \`message.retry()\` and the \`@vercel/queue\` SDK keep \`${name}\`.`)
  })
}

function usesQueue(context: FileContext): boolean {
  if (context.imports.size) return true
  let used = false
  walk(context.program, (node) => {
    if (!used && node.type === "CallExpression" && node.callee.type === "Identifier" && autoImports.has(node.callee.name) && !context.resolve(node.callee)) used = true
  })
  return used
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const files = (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of files) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!needle.test(code)) continue
    let program: File
    try {
      program = parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
    }
    catch (error) {
      if (/vite-hub\/queue|sendQueue|useQueue/.test(code)) {
        followUps.push({ file, message: `The codemod could not parse this file (${error instanceof Error ? error.message : String(error)}). Rename the Queue \`delaySeconds\` to \`delay\` and \`retentionSeconds\` to \`retention\` by hand.` })
      }
      continue
    }
    const context: FileContext = {
      changed: 0,
      clients: new Set(),
      code,
      file,
      followUps,
      handled: new Set(),
      imports: collectImports(program),
      output: new MagicString(code),
      program,
      resolve: bindingResolver(program),
      style: detectStyle(code, program),
    }
    // A file with no Queue import and no auto-imported Queue call can use the native Cloudflare or Vercel API.
    if (!usesQueue(context)) continue
    collectClients(context)
    keepNativeRetries(context)
    rewriteCalls(context)
    reportLeftovers(context)
    if (context.changed) edits.push({ path: file, before: code, after: context.output.toString() })
  }
  return {
    summary: edits.length ? `renamed the Queue \`delaySeconds\` and \`retentionSeconds\` in ${edits.length} file(s)` : followUps.length ? "found Queue times that need a manual change" : "found no Queue `delaySeconds` or `retentionSeconds`",
    edits,
    followUps,
    notes: edits.length || followUps.length ? ["Queue `delay` takes a duration string, such as \"60s\" or \"5m\". `retention` takes a duration or a number of seconds. A send that still passes `delaySeconds` or `retentionSeconds` fails with `QUEUE_UNSUPPORTED_OPTION`."] : [],
    nextSteps: edits.length ? ["Run your typecheck. It finds Queue options that other files build."] : [],
  }
}

export const queueDurations: Codemod = {
  name: "queue-durations",
  description: "Rename the Queue delaySeconds to delay and retentionSeconds to retention, and write delay as a duration such as \"60s\"",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} uses the Queue \`delaySeconds\` or \`retentionSeconds\`` }
    const [first] = result.followUps
    return first ? { reason: `${first.file ?? "The application"} needs the Queue \`delay\` rename` } : undefined
  },
  run: migrate,
}
