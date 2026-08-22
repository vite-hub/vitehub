import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

function staticStringKey(key: ESTree.Node): string | null {
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : null;
  if (key.type !== "TemplateLiteral" || key.expressions.length > 0) return null;
  return key.quasis.length === 1 ? (key.quasis[0]?.value.cooked ?? null) : null;
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    const reportForbiddenLiteralKey = (
      node: ESTree.Node & { key: ESTree.Node; computed?: boolean },
    ) => {
      const name = staticStringKey(node.key);
      if (name === null || !containsForbiddenSymbolName(name)) return;
      context.report({
        node: node.key,
        messageId: "forbiddenSymbolName",
        data: { name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
      Property: reportForbiddenLiteralKey,
      PropertyDefinition: reportForbiddenLiteralKey,
      AccessorProperty: reportForbiddenLiteralKey,
      MethodDefinition: reportForbiddenLiteralKey,
      MemberExpression(node) {
        if (!node.computed) return;
        reportForbiddenLiteralKey({ ...node, key: node.property });
      },
      TSEnumMember(node) {
        if (node.id.type !== "Literal" || typeof node.id.value !== "string") return;
        reportForbiddenLiteralKey({ ...node, key: node.id });
      },
      TSAbstractAccessorProperty: reportForbiddenLiteralKey,
      TSPropertySignature: reportForbiddenLiteralKey,
      TSMethodSignature: reportForbiddenLiteralKey,
    };
  },
});
