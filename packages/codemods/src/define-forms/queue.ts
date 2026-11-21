import { end, keyName, start, walk } from "@vite-hub/internal/ast"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { followUpAt, importedName } from "./shared.ts"

import type MagicString from "magic-string"
import type { Identifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { FollowUp } from "../types.ts"
import type { ParsedFile, SourceFile } from "./shared.ts"

const queueModules = new Set(["vite-hub/queue", "@vite-hub/queue"])
const queueOptions = new Set(["cache", "callbackOptions", "concurrency", "onDispatchError", "onError"])

function unwrap(node: Node): Node {
  while (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSTypeAssertion" || node.type === "TSNonNullExpression" || node.type === "TSInstantiationExpression") {
    node = node.expression
  }
  return node
}

function isFunction(node: Node): boolean {
  const value = unwrap(node)
  return value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression"
}

function argumentStart(node: Node): number {
  return typeof node.extra?.parenStart === "number" ? node.extra.parenStart : start(node)
}

function withoutDelimiters(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*|[ \t]*[(){},][ \t]*/g, match => match.startsWith("/") ? match : "")
}

/** Moves confirmed legacy calls without rewriting or re-evaluating their handlers. */
export function rewriteQueues(file: SourceFile, parsed: ParsedFile, output: MagicString, followUps: FollowUp[]): number {
  if (!file.code.includes("defineQueue")) return 0
  const resolve = bindingResolver(parsed.program)
  const imports = new Set<Identifier>()
  const handlers = new Set<Identifier>()
  walk(parsed.program, (node, ancestors) => {
    if (node.type === "ImportDeclaration" && node.importKind !== "type" && queueModules.has(node.source.value)) {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && importedName(specifier) === "defineQueue") imports.add(specifier.local)
      }
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isFunction(node.init)) {
      const declaration = ancestors.at(-1)
      if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") handlers.add(node.id)
    }
  })

  let count = 0
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
    const binding = resolve(node.callee)
    if (binding ? !imports.has(binding) : node.callee.name !== "defineQueue") return
    const [handler, options, ...rest] = node.arguments
    if (!handler) return
    const report = (message: string) => followUps.push(followUpAt(file.path, node, message))
    if (handler.type === "SpreadElement" || options?.type === "SpreadElement" || rest.length) {
      report("Check this Queue call's arguments. If it passes a positional handler, move it and any options into one object with a `handler` property.")
      return
    }
    const value = unwrap(handler)
    if (value.type === "ObjectExpression") return
    if (!options && !isFunction(value)) {
      if (value.type !== "Identifier") return
      const handlerBinding = resolve(value)
      if (!handlerBinding || !handlers.has(handlerBinding)) return
    }

    const close = end(node) - 1
    let closingBrace = " }"
    if (options) {
      if (options.type !== "ObjectExpression" || options.properties.some((property) => {
        if (property.type !== "ObjectProperty" || property.computed) return true
        const name = keyName(property.key)
        return name === undefined || !queueOptions.has(name)
      })) {
        report("Move this Queue's options into the definition by hand. Copy only supported Queue options and keep the original handler and argument evaluation order.")
        return
      }
      const opening = argumentStart(options)
      const last = end(options) - 1
      let first = start(options) + 1
      if (/[ \t]/.test(file.code[opening - 1])) {
        while (first < last && /[ \t]/.test(file.code[first])) first++
      }
      const suffix = withoutDelimiters(file.code.slice(last, close))
      if (!suffix && first < last && /\s/.test(file.code[last - 1])) closingBrace = "}"
      output.overwrite(opening, first, withoutDelimiters(file.code.slice(opening, first)))
      output.overwrite(last, close, suffix)
    }
    const shorthand = handler.type === "Identifier" && handler.name === "handler" && start(handler) === argumentStart(handler)
    output.appendLeft(argumentStart(handler), shorthand ? "{ " : "{ handler: ")
    output.appendLeft(close, closingBrace)
    count++
  })
  return count
}
