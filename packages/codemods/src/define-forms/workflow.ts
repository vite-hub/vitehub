import { end, start, walk } from "@vite-hub/internal/ast"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { defineFunctionNames, followUpAt } from "./shared.ts"

import type MagicString from "magic-string"
import type { ArrowFunctionExpression, CallExpression, FunctionDeclaration, FunctionExpression, Identifier } from "@babel/types"
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

function propertyName(property: Node & { key: Node, computed?: boolean }): string | undefined {
  if (property.key.type === "StringLiteral") return property.key.value
  if (!property.computed && property.key.type === "Identifier") return property.key.name
  return undefined
}

function contextName(code: string): string {
  let name = "workflowContext"
  while (code.includes(name)) name += "_"
  return name
}

function payloadAnnotation(param: FunctionNode["params"][number] | undefined) {
  const binding = param?.type === "AssignmentPattern" ? param.left : param
  return binding && "typeAnnotation" in binding && binding.typeAnnotation?.type === "TSTypeAnnotation"
    ? binding.typeAnnotation.typeAnnotation
    : undefined
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

  const annotation = payloadAnnotation(payloadParam)
  const payloadType = annotation && text(annotation)
  const withoutType = (node: Node & { typeAnnotation?: Node | null }) => {
    const annotation = node.typeAnnotation
    if (!annotation || annotation.type !== "TSTypeAnnotation") return text(node)
    return code.slice(start(node), start(annotation)).trimEnd().replace(/\?$/, "")
  }

  if (contextParam?.type === "Identifier" || contextParam?.type === "ObjectPattern" &&
    (contextParam.typeAnnotation || contextParam.properties.some(property => property.type === "RestElement" || property.computed || propertyName(property) === "payload"))) {
    const context = contextName(code)
    return { text: `${context} => (${text(handler)})(${context}.payload, ${context})`, payloadType }
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

  if (contextParam?.type === "ObjectPattern") {
    fields.push(...contextParam.properties.map(text))
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
  const node = call.typeArguments
  if (!node) return undefined
  return { node, params: node.params.map(param => code.slice(start(param), end(param))) }
}

/** Rewrites one handler, or wraps a handler that a name references, such as `onboard`. */
function rewriteHandler(file: SourceFile, handler: Node, followUps: FollowUp[], local?: FunctionNode | FunctionDeclaration): HandlerRewrite | undefined {
  const text = file.code.slice(start(handler), end(handler))
  if (isFunction(handler)) {
    const rewritten = rewriteHandlerParams(file.code, handler)
    if (!rewritten) followUps.push(followUpAt(file.path, handler, "The codemod could not rewrite the parameters of this Workflow handler. A handler now takes one object: `async ({ payload, steps, sleep }) => { ... }`. Rewrite it by hand."))
    return rewritten
  }
  if (!local || local.generator || local.params.length > 2 || local.params.some(param => param.type === "RestElement" || param.type === "Identifier" && param.name === "this")) {
    followUps.push(followUpAt(file.path, handler, "The codemod could not determine this Workflow handler's parameters. Change it to take one context object and pass it as `defineWorkflow({ handler })`."))
    return undefined
  }
  const context = contextName(file.code)
  const args = [`${context}.payload`, context].slice(0, local.params.length)
  followUps.push(followUpAt(file.path, handler, `The codemod wrapped \`${text}\` to keep its positional Workflow handler arguments. You can change it to take one context object and pass it directly.`))
  return {
    text: args.length ? `${context} => ${text}(${args.join(", ")})` : `() => ${text}()`,
    payloadType: payloadAnnotation(local.params[0]) ? `Parameters<typeof ${text}>[0]` : undefined,
  }
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
  const resolveBinding = bindingResolver(parsed.program)
  const handlers = new Map<Identifier, FunctionNode | FunctionDeclaration>()
  walk(parsed.program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) handlers.set(node.id, node)
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFunction(node.init)) handlers.set(node.id, node.init)
  })
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
      const [first, second] = args
      if (!first || first.type === "ObjectExpression") return
      if (args.some(arg => arg.type === "SpreadElement")) {
        followUps.push(followUpAt(file.path, node, "`defineWorkflow(name, handler, options)` was removed. Rewrite this call as `defineWorkflow({ handler, ...options })` by hand."))
        return
      }
      // `defineWorkflow(handler, options)` came before `defineWorkflow(name, handler, options)`, and its handler took one object.
      const firstBinding = first.type === "Identifier" ? resolveBinding(first) : undefined
      const oldest = isFunction(first) || args.length <= 2 && (
        firstBinding !== undefined && handlers.has(firstBinding)
        || first.type === "Identifier" && second?.type === "ObjectExpression"
      )
      const [handler, options, ...rest] = oldest ? args : args.slice(1)
      if (!handler || rest.length || handler.type === "SpreadElement" || options?.type === "SpreadElement") {
        followUps.push(followUpAt(file.path, node, "`defineWorkflow(name, handler, options)` was removed. Rewrite this call as `defineWorkflow({ handler, ...options })` by hand."))
        return
      }
      const optionKeys = options?.type === "ObjectExpression" ? options.properties.map(property => property.type === "SpreadElement" ? undefined : propertyName(property)) : []
      if (options && (options.type !== "ObjectExpression" || optionKeys.some(key => key !== "id" && key !== "native" && key !== "rootStep"))) {
        followUps.push(followUpAt(file.path, options, "Make the Workflow options explicit before migrating this definition. Only `native` and `rootStep` are accepted; remove the former `id` option."))
        return
      }
      const binding = handler.type === "Identifier" ? resolveBinding(handler) : undefined
      const rewritten = oldest ? { text: text(handler) } : rewriteHandler(file, handler, followUps, binding && handlers.get(binding))
      if (!rewritten) return

      const fields = [rewritten.text === "handler" ? "handler" : `handler: ${rewritten.text}`]
      if (options?.type === "ObjectExpression") {
        fields.push(...options.properties.filter((_, index) => optionKeys[index] !== "id").map(text))
      }
      output.overwrite(start(first), end(args.at(-1)!), `{ ${fields.join(", ")} }`)

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
    if (!second && first?.type !== "ObjectExpression") return
    const options = first?.type === "ObjectExpression" ? first : second?.type === "ObjectExpression" ? second : undefined
    const property = options?.properties.find(entry => entry.type !== "SpreadElement" && propertyName(entry) === "handler")
    const handler = options ? property?.type === "ObjectProperty" ? property.value : property : second
    if (isFunction(handler) && !handler.params.length) return
    const annotation = isFunction(handler) ? payloadAnnotation(handler.params[0]) : undefined
    if (isFunction(handler) && handler.params.length === 1 && annotation?.type === "TSTypeReference" && annotation.typeName.type === "Identifier" && annotation.typeName.name === "WorkflowExecutionContext") return
    const legacy = isFunction(handler) && (handler.params.length > 1 || annotation?.type === "TSTypeLiteral" && annotation.members.some(member => member.type === "TSPropertySignature" && !member.optional && !contextFields.has(propertyName(member) ?? "")))
    if (!legacy) {
      followUps.push(followUpAt(file.path, handler ?? node, "Check this `createWorkflow()` handler. If it still takes a positional payload or context, change it to take one context object, such as `({ payload, sleep }) => { ... }`."))
      return
    }
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
