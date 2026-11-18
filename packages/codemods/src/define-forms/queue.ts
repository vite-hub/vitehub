import { end, start, walk } from "@vite-hub/internal/ast"

import { defineFunctionNames, followUpAt } from "./shared.ts"

import type MagicString from "magic-string"
import type { ArrowFunctionExpression, FunctionExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

const queueModules: ReadonlySet<string> = new Set(["vite-hub/queue", "@vite-hub/queue"])
/** The fields of the job that a Queue handler receives, in the order the codemod destructures them. */
const jobFields = ["payload", "id", "attempts", "metadata"]

/** True when `node` names a property or a key, so renaming a variable does not change it. */
function isPropertyName(node: Node, parent: Node | undefined): boolean {
  if (!parent) return false
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node) return !parent.computed
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassProperty" || parent.type === "ClassMethod" || parent.type === "TSPropertySignature") && parent.key === node) {
    return !parent.computed && !(parent.type === "ObjectProperty" && parent.shorthand)
  }
  return false
}

/**
 * Rewrites `(job) => job.payload` to `({ payload }) => payload`. Returns the new handler text, or `undefined` when the
 * handler uses the job in another way, such as `send(job)`, or when a destructured name would shadow another name.
 */
function destructureJob(code: string, handler: ArrowFunctionExpression | FunctionExpression): string | undefined {
  const [param, ...others] = handler.params
  if (param?.type !== "Identifier" || others.length) return undefined
  const name = param.name
  const reads: { start: number, end: number, field: string }[] = []
  let safe = true
  walk(handler.body, (node, ancestors) => {
    if (!safe || node.type !== "Identifier") return
    const parent = ancestors.at(-1)
    if (isPropertyName(node, parent)) return
    if (node.name === name) {
      const member = parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.type === "Identifier" ? parent : undefined
      const field = member?.property.type === "Identifier" ? member.property.name : undefined
      const written = ancestors.at(-2)
      const assigned = (written?.type === "AssignmentExpression" && written.left === member)
        || written?.type === "UpdateExpression"
        || (written?.type === "UnaryExpression" && written.operator === "delete")
      if (!member || !field || !jobFields.includes(field) || assigned) safe = false
      else reads.push({ start: start(member), end: end(member), field })
    }
    else if (jobFields.includes(node.name)) {
      safe = false
    }
  })
  if (!safe || !reads.length) return undefined

  const base = start(handler)
  const fields = jobFields.filter(field => reads.some(read => read.field === field))
  const paren = code.slice(base, start(param)).includes("(")
  const pattern = paren ? `{ ${fields.join(", ")} }` : `({ ${fields.join(", ")} })`
  const edits = [{ start: start(param), end: start(param) + name.length, text: pattern }, ...reads.map(read => ({ ...read, text: read.field }))]
    .sort((left, right) => right.start - left.start)
  let text = code.slice(base, end(handler))
  for (const edit of edits) text = text.slice(0, edit.start - base) + edit.text + text.slice(edit.end - base)
  return text
}

/**
 * Rewrites `defineQueue(handler, options)` to `defineQueue({ handler, ...options })`. When the handler reads only
 * `job.payload`, `job.id`, `job.attempts`, or `job.metadata`, the codemod destructures them. Other handlers still work,
 * because the handler receives the same object, and the codemod reports them.
 */
export function rewriteQueues(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("defineQueue")) return 0
  const names = defineFunctionNames(parsed.program, "defineQueue", queueModules)
  const text = (node: Node) => file.code.slice(start(node), end(node))
  let count = 0
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !names.has(node.callee.name)) return
    const [handler, options, ...rest] = node.arguments
    if (!handler || handler.type === "ObjectExpression") return
    if (handler.type === "SpreadElement" || options?.type === "SpreadElement" || rest.length) {
      followUps.push(followUpAt(file.path, node, "`defineQueue(handler, options)` was removed. Rewrite this call as `defineQueue({ handler, ...options })` by hand."))
      return
    }
    let handlerText = text(handler)
    if (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") {
      const param = handler.params[0]
      const destructured = destructureJob(file.code, handler)
      if (destructured) handlerText = destructured
      else if (param?.type === "Identifier") {
        followUps.push(followUpAt(file.path, handler, `This Queue handler uses \`${param.name}\` in a way that the codemod does not rewrite. It still works: the handler receives one object. To match the docs, destructure it, for example \`async ({ payload }) => { ... }\`.`))
      }
    }
    const fields = [handlerText === "handler" ? "handler" : `handler: ${handlerText}`]
    if (options?.type === "ObjectExpression") fields.push(...options.properties.map(text))
    else if (options) fields.push(`...${text(options)}`)
    output.overwrite(start(handler), end(options ?? handler), `{ ${fields.join(", ")} }`)
    count++
  })
  return count
}
