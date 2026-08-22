import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const hostGlobalNames = new Set(["global", "globalThis", "self", "window"]);

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function isUnshadowedHostGlobal(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): expression is ESTree.IdentifierReference {
  if (expression.type !== "Identifier" || !hostGlobalNames.has(expression.name)) return false;
  if (sourceCode.isGlobalReference(expression)) return true;
  const variable = resolveVariable(sourceCode, expression);
  return variable === null || variable.defs.length === 0;
}

function isGlobalReflect(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  visited = new Set<Variable>(),
): boolean {
  while (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSNonNullExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSTypeAssertion"
  ) {
    expression = expression.expression;
  }
  if (expression.type === "Identifier" && expression.name === "Reflect") {
    if (sourceCode.isGlobalReference(expression)) return true;
    const variable = resolveVariable(sourceCode, expression);
    return variable === null || variable.defs.length === 0;
  }
  if (expression.type === "Identifier") {
    const variable = resolveVariable(sourceCode, expression);
    if (variable === null || visited.has(variable)) return false;
    visited.add(variable);
    return variable.defs.some(
      (definition) =>
        definition.type === "Variable" &&
        definition.node.type === "VariableDeclarator" &&
        definition.node.id.type === "Identifier" &&
        definition.parent?.type === "VariableDeclaration" &&
        definition.parent.kind === "const" &&
        definition.node.init !== null &&
        isGlobalReflect(sourceCode, definition.node.init, visited),
    );
  }
  if (expression.type !== "MemberExpression") return false;
  const property = expression.property;
  const isReflectProperty = expression.computed
    ? property.type === "Literal" && property.value === "Reflect"
    : property.type === "Identifier" && property.name === "Reflect";
  return (
    isReflectProperty &&
    isUnshadowedHostGlobal(sourceCode, expression.object)
  );
}

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
  visited = new Set<Variable>(),
): boolean {
  while (
    callee.type === "ParenthesizedExpression" ||
    callee.type === "TSAsExpression" ||
    callee.type === "TSNonNullExpression" ||
    callee.type === "TSSatisfiesExpression" ||
    callee.type === "TSTypeAssertion"
  ) {
    callee = callee.expression;
  }
  if (callee.type === "Identifier") {
    const variable = resolveVariable(sourceCode, callee);
    if (variable === null || visited.has(variable)) return false;
    visited.add(variable);
    return variable.defs.some((definition) => {
      if (
        definition.type !== "Variable" ||
        definition.node.type !== "VariableDeclarator" ||
        definition.parent?.type !== "VariableDeclaration" ||
        definition.parent.kind !== "const" ||
        definition.node.init === null
      ) {
        return false;
      }
      const { id, init } = definition.node;
      if (id.type === "Identifier") {
        return isGlobalReflectMethodCall(sourceCode, init, methodName, visited);
      }
      if (id.type !== "ObjectPattern" || !isGlobalReflect(sourceCode, init)) return false;
      return id.properties.some((property) => {
        if (property.type !== "Property") return false;
        const binding =
          property.value.type === "AssignmentPattern" ? property.value.left : property.value;
        if (binding.type !== "Identifier" || binding.name !== callee.name) return false;
        const name =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal"
              ? property.key.value
              : null;
        return name === methodName;
      });
    });
  }
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  if (!isGlobalReflect(sourceCode, callee.object)) return false;
  const property = callee.property;
  return callee.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName;
}
