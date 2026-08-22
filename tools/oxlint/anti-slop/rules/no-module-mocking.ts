import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

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

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function memberName(expression: ESTree.MemberExpression): string | null {
  if (!expression.computed) return expression.property.name;
  return expression.property.type === "Literal" && typeof expression.property.value === "string"
    ? expression.property.value
    : null;
}

function objectPatternPropertyName(
  pattern: ESTree.ObjectPattern,
  bindingName: string,
): string | null {
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const value = property.value.type === "AssignmentPattern"
      ? property.value.left
      : property.value;
    if (value.type !== "Identifier" || value.name !== bindingName) continue;
    const name = !property.computed && property.key.type === "Identifier"
      ? property.key.name
      : property.key.type === "Literal"
        ? property.key.value
        : null;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function isTestFrameworkNamespace(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  expectedSource: "@jest/globals" | "vitest",
  visited: Set<Variable>,
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
  if (expression.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || visited.has(variable)) return false;
  visited.add(variable);
  return variable.defs.some((definition) => {
    if (definition.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration") {
      return (
        definition.node.type === "ImportNamespaceSpecifier" &&
        definition.parent.source.value === expectedSource
      );
    }
    return (
      definition.type === "Variable" &&
      definition.node.type === "VariableDeclarator" &&
      definition.node.id.type === "Identifier" &&
      definition.parent?.type === "VariableDeclaration" &&
      definition.parent.kind === "const" &&
      definition.node.init !== null &&
      isTestFrameworkNamespace(sourceCode, definition.node.init, expectedSource, visited)
    );
  });
}

function isTestFrameworkObject(
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
  if (expression.type === "MemberExpression") {
    const name = memberName(expression);
    const expectedSource =
      name === "vi" ? "vitest" : name === "jest" ? "@jest/globals" : null;
    return (
      expectedSource !== null &&
      isTestFrameworkNamespace(sourceCode, expression.object, expectedSource, visited)
    );
  }
  if (expression.type !== "Identifier") return false;
  if (
    (expression.name === "vi" || expression.name === "jest") &&
    sourceCode.isGlobalReference(expression)
  ) {
    return true;
  }

  const variable = resolveVariable(sourceCode, expression);
  if (variable === null) return expression.name === "vi" || expression.name === "jest";
  if (visited.has(variable)) return false;
  if (variable.defs.length === 0) {
    return expression.name === "vi" || expression.name === "jest";
  }
  visited.add(variable);
  return variable.defs.some((definition) => {
    if (definition.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration") {
      const source = definition.parent.source.value;
      const name = importedName(definition.node);
      return (
        (source === "vitest" && name === "vi") ||
        (source === "@jest/globals" && name === "jest")
      );
    }
    if (
      definition.type !== "Variable" ||
      definition.node.type !== "VariableDeclarator" ||
      definition.parent?.type !== "VariableDeclaration" ||
      definition.parent.kind !== "const" ||
      definition.node.init === null
    ) {
      return false;
    }
    if (definition.node.id.type === "Identifier") {
      return isTestFrameworkObject(sourceCode, definition.node.init, visited);
    }
    if (definition.node.id.type !== "ObjectPattern") return false;
    const name = objectPatternPropertyName(definition.node.id, expression.name);
    const expectedSource = name === "vi" ? "vitest" : name === "jest" ? "@jest/globals" : null;
    return expectedSource !== null && isTestFrameworkNamespace(
      sourceCode,
      definition.node.init,
      expectedSource,
      visited,
    );
  });
}

function moduleMockCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
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
        definition.parent.kind !== "const"
      ) {
        return false;
      }
      const { id, init } = definition.node;
      if (init === null) return false;
      if (id.type === "Identifier") return moduleMockCall(sourceCode, init, visited);
      if (id.type !== "ObjectPattern" || !isTestFrameworkObject(sourceCode, init)) return false;
      const method = objectPatternPropertyName(id, callee.name);
      return method !== null && moduleMockMethods.has(method);
    }) ?? false;
  }
  if (!("property" in callee) || !("object" in callee) || !("computed" in callee)) return false;
  if (!isTestFrameworkObject(sourceCode, callee.object)) return false;
  const property = callee.property;
  const method = callee.computed
    ? property.type === "Literal" &&
      (property.value === "doMock" ||
        property.value === "mock" ||
        property.value === "unstable_mockModule")
      ? property.value
      : null
    : property.type === "Identifier"
      ? property.name
      : null;
  return method !== null && moduleMockMethods.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
