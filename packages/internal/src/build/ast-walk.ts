/**
 * AST helpers that do not load the parser. Code that must not import `vite` when it loads, such as the Rolldown
 * plugins of a package whose `vite` peer is optional, imports these and loads `parseSync` with `import("vite")`.
 */
import type { ESTree } from "vite"

type Node = ESTree.Node

/** The oxc parser grammar for a file, from its extension. Defaults to TypeScript. */
export function moduleLanguage(file: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.(?:c|m)?tsx$/i.test(file)) return "tsx"
  if (/\.(?:c|m)?jsx$/i.test(file)) return "jsx"
  if (/\.(?:c|m)?js$/i.test(file)) return "js"
  return "ts"
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

/** Visits `node` and its descendants. Return `false` from `visit` to skip the children of a node. */
export function walk(node: Node, visit: (node: Node, parent: Node | undefined) => boolean | void, parent?: Node): void {
  if (visit(node, parent) === false) return
  // SAFETY: AST nodes are plain objects. Reading their fields by key only selects child nodes and arrays.
  const fields = node as unknown as Record<string, unknown>
  for (const key in fields) {
    const child = fields[key]
    if (typeof child !== "object" || child === null || key === "parent") continue
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit, node)
    }
    else if (isNode(child)) walk(child, visit, node)
  }
}
