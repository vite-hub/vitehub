import { walk } from "@vite-hub/internal/ast"

import type { File, Identifier } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"

interface Scope {
  parent?: Scope
  bindings: Map<string, Identifier>
  hoists: boolean
}

/** Resolve identifiers to declarations, including block bindings, parameters, and hoisted var declarations. */
export function bindingResolver(program: File): (node: Identifier) => Identifier | undefined {
  const scopes = new Map<Node, Scope>()
  const declare = (node: Node | null | undefined, scope: Scope): void => {
    if (!node) return
    if (node.type === "Identifier") scope.bindings.set(node.name, node)
    else if (node.type === "RestElement") declare(node.argument, scope)
    else if (node.type === "AssignmentPattern") declare(node.left, scope)
    else if (node.type === "ArrayPattern") node.elements.forEach(element => declare(element, scope))
    else if (node.type === "ObjectPattern") node.properties.forEach(property => declare(property.type === "RestElement" ? property.argument : property.value, scope))
    else if (node.type === "TSParameterProperty") declare(node.parameter, scope)
  }
  walk(program, (node, ancestors) => {
    const parent = ancestors.at(-1)
    const outer = parent ? scopes.get(parent) : undefined
    const fn = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression"
      || node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod" || node.type === "TSDeclareFunction"
    const ownsScope = fn || node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock"
      || node.type === "CatchClause" || node.type === "ForStatement" || node.type === "ForInStatement" || node.type === "ForOfStatement"
      || node.type === "SwitchStatement" || node.type === "ClassDeclaration" || node.type === "ClassExpression"
    const scope = ownsScope || !outer ? { parent: outer, bindings: new Map<string, Identifier>(), hoists: fn || node.type === "Program" || node.type === "StaticBlock" } : outer
    scopes.set(node, scope)
    if (fn) {
      if ("id" in node) declare(node.id, node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction" ? outer ?? scope : scope)
      node.params.forEach(param => declare(param, scope))
    }
    else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") declare(node.id, node.type === "ClassDeclaration" ? outer ?? scope : scope)
    else if (node.type === "VariableDeclarator") {
      let target = scope
      if (parent?.type === "VariableDeclaration" && parent.kind === "var") {
        while (!target.hoists && target.parent) target = target.parent
      }
      declare(node.id, target)
    }
    else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") declare(node.local, scope)
    else if (node.type === "CatchClause") declare(node.param, scope)
    else if (node.type === "TSEnumDeclaration" || node.type === "TSImportEqualsDeclaration") declare(node.id, scope)
  })
  return (node) => {
    let scope = scopes.get(node)
    while (scope) {
      const binding = scope.bindings.get(node.name)
      if (binding) return binding
      scope = scope.parent
    }
    return undefined
  }
}
