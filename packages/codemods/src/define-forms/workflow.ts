import { end, start, walk } from "@vite-hub/internal/ast"

import { defineFunctionNames, followUpAt } from "./shared.ts"

import type MagicString from "magic-string"
import type { ArrowFunctionExpression, CallExpression, FunctionExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

const workflowModules: ReadonlySet<string> = new Set(["vite-hub/workflow", "@vite-hub/workflow"])

type FunctionNode = ArrowFunctionExpression | FunctionExpression

function isFunction(node: Node | undefined | null): node is FunctionNode {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression"
}

/** The fields of the one object that a Workflow handler receives. */
const contextFields: ReadonlySet<string> = new Set(["id", "name", "payload", "provider", "sleep", "step", "steps"])

/** True when the handler already takes the one object, such as `({ payload, sleep })`, so a second run changes nothing. */
function isContextPattern(handler: FunctionNode): boolean {
  const [param, ...others] = handler.params
  if (others.length || param?.type !== "ObjectPattern") return false
  return param.properties.every(property => property.type === "RestElement" || (property.key.type === "Identifier" && contextFields.has(property.key.name)))
}

/** The old handler takes `(payload, context)`. The new handler takes one object. */
interface HandlerRewrite {
  /** The new handler text. */
  text: string
  /** The type of `payload` that the old handler annotated, to move to the type argument. */
  payloadType?: string
}

/**
 * Rewrites `(payload: T, { steps })` to `({ payload, steps })` and returns the payload type `T`. Returns `undefined`
 * when the parameters use a form that the codemod does not rewrite, such as a rest parameter or a context default.
 */
function rewriteHandlerParams(code: string, handler: FunctionNode): HandlerRewrite | undefined {
  const text = (node: Node) => code.slice(start(node), end(node))
  const base = start(handler)
  const [payloadParam, contextParam, ...others] = handler.params
  if (!payloadParam) return { text: text(handler) }
  if (others.length || payloadParam.type === "RestElement" || contextParam?.type === "RestElement" || contextParam?.type === "AssignmentPattern") return undefined

  let payloadType: string | undefined
  const withoutType = (node: Node & { typeAnnotation?: Node | null }) => {
    const annotation = node.typeAnnotation
    if (!annotation || annotation.type !== "TSTypeAnnotation") return text(node)
    payloadType ??= text(annotation.typeAnnotation)
    return code.slice(start(node), start(annotation)).trimEnd().replace(/\?$/, "")
  }

  const fields: string[] = []
  if (payloadParam.type === "Identifier") {
    const name = withoutType(payloadParam)
    fields.push(name === "payload" ? "payload" : `payload: ${name}`)
  }
  else if (payloadParam.type === "AssignmentPattern") {
    const left = payloadParam.left
    const name = left.type === "Identifier" || left.type === "ObjectPattern" || left.type === "ArrayPattern" ? withoutType(left) : text(left)
    fields.push(`${name === "payload" ? "payload" : `payload: ${name}`} = ${text(payloadParam.right)}`)
  }
  else if (payloadParam.type === "ObjectPattern" || payloadParam.type === "ArrayPattern") {
    fields.push(`payload: ${withoutType(payloadParam)}`)
  }
  else {
    return undefined
  }

  if (contextParam?.type === "Identifier") {
    fields.push(`...${contextParam.name}`)
  }
  else if (contextParam?.type === "ObjectPattern") {
    const properties = contextParam.properties
    // The context had `payload` too. Two `payload` bindings would clash.
    if (properties.some(property => property.type === "ObjectProperty" && property.key.type === "Identifier" && property.key.name === "payload")) return undefined
    fields.push(...properties.map(text))
  }
  else if (contextParam) {
    return undefined
  }

  const last = contextParam ?? payloadParam
  const before = code.slice(base, start(payloadParam))
  const after = code.slice(end(last), end(handler))
  const pattern = `{ ${fields.join(", ")} }`
  // `payload => ...` has no parentheses around its parameter.
  const params = before.includes("(") ? pattern : `(${pattern})`
  return { text: `${before}${params}${after}`, payloadType }
}

/** The type arguments of a call, such as `<"onboard", Payload>`, as text. */
function typeArguments(code: string, call: CallExpression): { node: Node, params: string[] } | undefined {
  const node = call.typeParameters ?? call.typeArguments
  if (!node) return undefined
  return { node, params: node.params.map(param => code.slice(start(param), end(param))) }
}

/** Rewrites one handler, or wraps a handler that a name references, such as `onboard`. */
function rewriteHandler(file: SourceFile, handler: Node, followUps: FollowUp[]): HandlerRewrite | undefined {
  const text = file.code.slice(start(handler), end(handler))
  if (isFunction(handler)) {
    const rewritten = rewriteHandlerParams(file.code, handler)
    if (!rewritten) followUps.push(followUpAt(file.path, handler, "The codemod could not rewrite the parameters of this Workflow handler. A handler now takes one object: `async ({ payload, steps, sleep }) => { ... }`. Rewrite it by hand."))
    return rewritten
  }
  // A name or a member, such as `onboard` or `handlers.onboard`, can be called as it is. Other expressions need parentheses.
  const callee = handler.type === "Identifier" || handler.type === "MemberExpression" ? text : `(${text})`
  followUps.push(followUpAt(file.path, handler, `This Workflow handler is not written in the call, so the codemod wrapped it: \`({ payload, ...context }) => ${callee}(payload, context)\`. You can change \`${text}\` to take one object, \`({ payload, steps, sleep })\`, and pass it directly.`))
  return { text: `({ payload, ...context }) => ${callee}(payload, context)` }
}

/**
 * Rewrites `defineWorkflow(name, handler, options)` to `defineWorkflow<Payload>({ handler, ...options })`. The file
 * path is the Workflow name now, so the name goes away. The handler takes one object, `{ payload, ...context }`, and
 * the payload type moves to the type argument. The former `defineWorkflow(handler, options)` form moves the same way.
 * `createWorkflow()` keeps its name, but its handler takes one object too.
 */
export function rewriteWorkflows(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("defineWorkflow") && !file.code.includes("createWorkflow")) return 0
  const defineNames = defineFunctionNames(parsed.program, "defineWorkflow", workflowModules)
  const createNames = defineFunctionNames(parsed.program, "createWorkflow", workflowModules)
  const text = (node: Node) => file.code.slice(start(node), end(node))
  let count = 0

  /** Puts the payload type in the type arguments of the call, when the call has none. */
  const setPayloadType = (call: CallExpression, payloadType: string | undefined) => {
    if (payloadType && !typeArguments(file.code, call)) output.appendLeft(end(call.callee), `<${payloadType}>`)
  }

  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
    if (defineNames.has(node.callee.name)) {
      const args = node.arguments
      if (!args.length || args[0]?.type === "ObjectExpression") return
      if (args.some(arg => arg.type === "SpreadElement")) {
        followUps.push(followUpAt(file.path, node, "`defineWorkflow(name, handler, options)` was removed. Rewrite this call as `defineWorkflow({ handler, ...options })` by hand."))
        return
      }
      // `defineWorkflow(handler, options)` came before `defineWorkflow(name, handler, options)`, and its handler took one object.
      const oldest = isFunction(args[0])
      const [handler, options, ...rest] = oldest ? args : args.slice(1)
      if (!handler || rest.length || handler.type === "SpreadElement" || options?.type === "SpreadElement") {
        followUps.push(followUpAt(file.path, node, "`defineWorkflow(name, handler, options)` was removed. Rewrite this call as `defineWorkflow({ handler, ...options })` by hand."))
        return
      }
      const rewritten = oldest ? { text: text(handler) } : rewriteHandler(file, handler, followUps)
      if (!rewritten) return

      const fields = [rewritten.text === "handler" ? "handler" : `handler: ${rewritten.text}`]
      if (options?.type === "ObjectExpression") {
        for (const property of options.properties) {
          // `id` did nothing, so `defineWorkflow()` does not accept it now.
          if (property.type === "ObjectProperty" && property.key.type === "Identifier" && property.key.name === "id") continue
          fields.push(text(property))
        }
      }
      else if (options) {
        fields.push(`...${text(options)}`)
      }
      output.overwrite(start(args[0]!), end(args.at(-1)!), `{ ${fields.join(", ")} }`)

      // The old type arguments were `<Name, Payload, Result>`. The name goes away.
      const types = typeArguments(file.code, node)
      if (types && !oldest) {
        const kept = types.params.slice(1)
        if (kept.length) output.overwrite(start(types.node), end(types.node), `<${kept.join(", ")}>`)
        else output.remove(start(types.node), end(types.node))
      }
      else {
        setPayloadType(node, rewritten.payloadType)
      }
      count++
      return
    }

    if (!createNames.has(node.callee.name)) return
    // `createWorkflow(name, handler, options)`, `createWorkflow(name, { handler })`, and `createWorkflow({ name, handler })`.
    const [first, second] = node.arguments
    const handler = isFunction(second)
      ? second
      : [second, first].map((arg) => {
          if (arg?.type !== "ObjectExpression") return undefined
          const property = arg.properties.find(entry => entry.type === "ObjectProperty" && entry.key.type === "Identifier" && entry.key.name === "handler")
          return property?.type === "ObjectProperty" && isFunction(property.value) ? property.value : undefined
        }).find(Boolean)
    if (!handler || !handler.params.length || isContextPattern(handler)) return
    const rewritten = rewriteHandlerParams(file.code, handler)
    if (!rewritten) {
      followUps.push(followUpAt(file.path, handler, "The codemod could not rewrite the parameters of this Workflow handler. A handler now takes one object: `async ({ payload, sleep }) => { ... }`. Rewrite it by hand."))
      return
    }
    output.overwrite(start(handler), end(handler), rewritten.text)
    setPayloadType(node, rewritten.payloadType)
    count++
  })
  return count
}
