import type { StringLiteral } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"

/** The literal module reference in ESM, CommonJS, and TypeScript imports. */
export function moduleSource(node: Node): StringLiteral | undefined {
  if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return node.source
  if (node.type === "ExportNamedDeclaration") return node.source ?? undefined
  if (node.type === "ImportExpression") return node.source.type === "StringLiteral" ? node.source : undefined
  if (node.type === "CallExpression" && (node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require"))) {
    return node.arguments[0]?.type === "StringLiteral" ? node.arguments[0] : undefined
  }
  if (node.type === "TSExternalModuleReference") return node.expression
  if (node.type === "TSImportType") return node.argument
  return undefined
}
