import { walk } from "@vite-hub/internal/ast"

import type { File } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"

/** Collect declarations conservatively across the block, including nested patterns. */
export function blockBindings(program: File): Map<string, Node[]> {
  const bindings = new Map<string, Node[]>()
  const add = (node: Node | null | undefined): void => {
    if (!node) return
    if (node.type === "Identifier") bindings.set(node.name, [...(bindings.get(node.name) ?? []), node])
    else if (node.type === "RestElement") add(node.argument)
    else if (node.type === "AssignmentPattern") add(node.left)
    else if (node.type === "ArrayPattern") node.elements.forEach(add)
    else if (node.type === "ObjectPattern") node.properties.forEach(property => add(property.type === "RestElement" ? property.argument : property.value))
    else if (node.type === "TSParameterProperty") add(node.parameter)
  }
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") add(node.id)
    else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") add(node.local)
    else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
      || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "TSDeclareFunction") {
      if ("id" in node) add(node.id)
      node.params.forEach(add)
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression" || node.type === "TSEnumDeclaration" || node.type === "TSImportEqualsDeclaration") add(node.id)
    else if (node.type === "CatchClause") add(node.param)
  })
  return bindings
}
