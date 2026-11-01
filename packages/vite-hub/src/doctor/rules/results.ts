import { createRule } from "vite-doctor/extension"
import type { DoctorRule } from "vite-doctor/extension"

import { callArguments, isFunctionNode, isIdentifier, isNodeType, numberValue, objectValue, parentOf, resolver, semanticParent, stringValue, unwrap, walkScript } from "../ast.ts"
import type { AstNode, Resolver } from "../ast.ts"
import { diagnostics } from "../diagnostics.ts"

type HandleKind = "kv" | "blob" | "media" | "email" | "channel" | "queueClient"

/** Methods that return `[error, value]` for each Runtime Helper handle. */
const tupleMethods: Record<HandleKind, Set<string>> = {
  kv: new Set(["clear", "del", "get", "getAndDelete", "has", "increment", "keys", "list", "set"]),
  blob: new Set(["createMultipartUpload", "del", "get", "handleMultipartUpload", "handleUpload", "head", "list", "put", "resumeMultipartUpload", "serve", "sign"]),
  media: new Set(["createFolder", "get", "handleUpload", "list", "move", "moveFolder", "put", "remove", "removeFolder", "replaceCrop", "update", "variants"]),
  email: new Set(["send"]),
  channel: new Set(["send"]),
  queueClient: new Set(["send", "sendBatch"]),
}

function handleKind(r: Resolver, node: unknown, seen = new Set<unknown>()): HandleKind | undefined {
  const target = unwrap(node)
  if (seen.has(target)) return
  seen.add(target)
  const reference = r.reference(target)
  if (reference && reference.path.length === 0) {
    if (reference.module === "kv" && reference.name === "kv") return "kv"
    if (reference.module === "blob" && reference.name === "blob") return "blob"
    if (reference.module === "email/server" && reference.name === "email") return "email"
  }
  if (reference?.module === "blob" && reference.name === "blob" && reference.path.length === 1 && reference.path[0] === "media") return "media"
  if (isNodeType(target, "MemberExpression") && target.computed !== true && isIdentifier(target.property, "media")) {
    return handleKind(r, target.object, seen) === "blob" ? "media" : undefined
  }
  if (isNodeType(target, "CallExpression")) {
    const callee = unwrap(target.callee)
    if (isNodeType(callee, "MemberExpression") && callee.computed !== true && isIdentifier(callee.property, "store")) {
      const kind = handleKind(r, callee.object, seen)
      return kind === "kv" || kind === "blob" ? kind : undefined
    }
    const called = r.callee(target)
    if (called && ["channels", "channels/server"].includes(called.module) && called.path.length === 0 && ["useChannel", "createChannel"].includes(called.name)) return "channel"
  }
  if (isNodeType(target, "AwaitExpression")) {
    const called = r.callee(target.argument)
    if (called?.module === "queue" && (called.name === "getQueue" && called.path.length === 0 || called.name === "dynamicQueue" && called.path.join(".") === "get")) return "queueClient"
  }
  // Follow `const store = kv.store("cache")` to its initializer.
  const binding = r.binding(target)
  if (binding && !binding.origin && isNodeType(binding.declaration, "VariableDeclarator") && isIdentifier(binding.declaration.id)) {
    return handleKind(r, binding.init, seen)
  }
}

/** A display name such as `kv.get()` when `call` returns an `[error, value]` tuple. */
function tupleCall(r: Resolver, call: AstNode): string | undefined {
  const callee = unwrap(call.callee)
  if (isNodeType(callee, "MemberExpression") && callee.computed !== true && isIdentifier(callee.property)) {
    const kind = handleKind(r, callee.object)
    if (kind && tupleMethods[kind].has(callee.property.name)) return `${callee.property.name}()`
  }
  const reference = r.callee(call)
  if (!reference) return
  if (reference.module === "queue" && reference.name === "runQueue" && reference.path.length === 0) return "runQueue()"
  if (reference.module === "queue" && reference.name === "dynamicQueue" && reference.path.join(".") === "run") return "dynamicQueue.run()"
  if (reference.module === "agent/mcp" && reference.name === "callMcpTool" && reference.path.length === 0) return "callMcpTool()"
  if (reference.module === "agent" && reference.name === "runAgent" && reference.path.length === 0) {
    const args = callArguments(call)
    // With a Runtime Context as the second argument, `runAgent()` returns the value and throws.
    if (args.length === 2 || args.length === 3 && stringValue(objectValue(args[2], "output")) === "drained") return "runAgent()"
  }
}

const handlerFactories = new Set(["defineEventHandler", "eventHandler", "defineHandler", "defineCachedEventHandler", "defineLazyEventHandler"])

/** True when `fn` is a route handler, so its return value becomes the response. */
function isRouteHandler(fn: AstNode): boolean {
  const { parent } = semanticParent(fn)
  if (parent?.type === "ExportDefaultDeclaration") return true
  if (parent?.type === "CallExpression" && isIdentifier(unwrap(parent.callee))) {
    const callee = unwrap(parent.callee)
    return isIdentifier(callee) && handlerFactories.has(callee.name)
  }
  return false
}

function enclosingFunctionOf(node: AstNode): AstNode | undefined {
  let current = parentOf(node)
  while (current) {
    if (isFunctionNode(current)) return current
    current = parentOf(current)
  }
}

type Misuse = "value" | "response"

/** True when a name that holds the tuple is later indexed, such as `result[0]`, or destructured. */
function readsAsTuple(r: Resolver, target: unknown): boolean {
  if (!isIdentifier(target)) return false
  const own = r.binding(target)
  if (!own) return false
  let found = false
  walkScript(r.ctx.file.scriptAst, (node) => {
    if (found || node === target || !isIdentifier(node, target.name) || r.binding(node) !== own) return
    const { parent, child } = semanticParent(node)
    if (parent?.type === "MemberExpression" && parent.object === child && parent.computed === true && numberValue(parent.property) !== undefined) found = true
    else if (parent?.type === "VariableDeclarator" && parent.init === child && isNodeType(parent.id, "ArrayPattern")) found = true
    else if (parent?.type === "AssignmentExpression" && parent.right === child && isNodeType(parent.left, "ArrayPattern")) found = true
  })
  return found
}

/** How the awaited tuple is used, when the use treats it as the value. */
function misuseOf(r: Resolver, awaited: AstNode): Misuse | undefined {
  const { parent, child } = semanticParent(awaited)
  if (!parent) return
  switch (parent.type) {
    case "VariableDeclarator":
      return isNodeType(parent.id, "ArrayPattern") || readsAsTuple(r, parent.id) ? undefined : "value"
    case "AssignmentExpression":
      return isNodeType(parent.left, "ArrayPattern") || readsAsTuple(r, parent.left) ? undefined : "value"
    case "LogicalExpression":
    case "BinaryExpression":
    case "TemplateLiteral":
    case "SpreadElement":
      return "value"
    case "ForOfStatement":
      return parent.right === child ? "value" : undefined
    case "Property":
      return parent.value === child ? "value" : undefined
    case "UnaryExpression":
      return parent.operator === "!" ? "value" : undefined
    case "MemberExpression": {
      if (parent.object !== child) return
      // `(await kv.get(key))[1]` reads the tuple by index on purpose.
      const property = unwrap(parent.property)
      return parent.computed === true && isNodeType(property, "Literal") && typeof property.value === "number" ? undefined : "value"
    }
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ConditionalExpression":
      return parent.test === child ? "value" : undefined
    case "ReturnStatement": {
      const fn = enclosingFunctionOf(parent)
      return fn && isRouteHandler(fn) ? "response" : undefined
    }
    case "ArrowFunctionExpression":
      return parent.body === child && isRouteHandler(parent) ? "response" : undefined
  }
}

export const destructureResultTuples: DoctorRule = createRule({
  meta: {
    id: "vitehub/destructure-result-tuples",
    title: "Destructure `[error, value]` results",
    category: "correctness",
    severity: "warn",
    requires: { script: true },
  },
  create(ctx) {
    const r = resolver(ctx)
    return {
      ScriptNode(node) {
        if (!isNodeType(node, "CallExpression")) return
        const name = tupleCall(r, node)
        if (!name) return
        const { parent } = semanticParent(node)
        // A returned promise resolves to the tuple too, so a route handler responds with it.
        const awaited = parent?.type === "AwaitExpression" ? parent : parent?.type === "ArrowFunctionExpression" || parent?.type === "ReturnStatement" ? node : undefined
        if (!awaited) return
        const misuse = misuseOf(r, awaited)
        if (!misuse) return
        const why = {
          "value": `\`${name}\` returns an \`[error, value]\` tuple and does not throw on failures. This code uses the tuple as the value. A tuple is always truthy, and the error is lost.`,
          "response": `\`${name}\` returns an \`[error, value]\` tuple. This route handler returns the tuple, so the client receives \`[error, value]\` as JSON and a failure still answers with status 200.`,
        }[misuse]
        ctx.report(diagnostics.VHUB0003({
          why,
          fix: `Destructure the result and handle the error: \`const [error, value] = await ${name.replace("()", "(...)")}\`, then \`if (error) throw error\`.`,
        }), { range: ctx.range(awaited) })
      },
    }
  },
})

export const rules: DoctorRule[] = [destructureResultTuples]
