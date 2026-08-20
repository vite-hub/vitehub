import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";
import { collectTypeAliases } from "../shared/type-aliases.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

type TypeBinding = {
  type: ESTree.TSType;
  bindings: ReadonlyMap<string, TypeBinding>;
};

function typeName(type: ESTree.TSTypeName): string {
  return type.type === "Identifier"
    ? type.name
    : `${typeName(type.left)}.${type.right.name}`;
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    let findAlias: ReturnType<typeof collectTypeAliases>;

    const resolvesToUnknown = (
      type: ESTree.TSType,
      shadowedAliases: ReadonlySet<string>,
      from: ESTree.Node,
      bindings: ReadonlyMap<string, TypeBinding> = new Map(),
      visited = new Set<string>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, shadowedAliases, from, bindings, visited);
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToUnknown(member, shadowedAliases, from, bindings, visited),
        );
      }
      if (
        type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike")
      ) {
        const value = type.typeArguments?.params[0];
        return value !== undefined && resolvesToUnknown(value, shadowedAliases, from, bindings, visited);
      }
      if (type.type !== "TSTypeReference") return false;
      const name = typeName(type.typeName);
      const bound = bindings.get(name);
      if (bound !== undefined) {
        return resolvesToUnknown(bound.type, shadowedAliases, from, bound.bindings, visited);
      }
      if (visited.has(name) || shadowedAliases.has(name)) return false;
      const alias = findAlias(name, from);
      if (alias === undefined) return false;
      const parameters = alias.typeParameters?.params ?? [];
      const arguments_ = type.typeArguments?.params ?? [];
      if (arguments_.length > parameters.length) return false;
      const nextBindings = new Map(bindings);
      for (const [index, parameter] of parameters.entries()) {
        const argument = arguments_[index] ?? parameter.default;
        if (argument === null || argument === undefined) return false;
        nextBindings.set(parameter.name.name, {
          type: argument,
          bindings: arguments_[index] === undefined ? nextBindings : bindings,
        });
      }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToUnknown(alias.typeAnnotation, shadowedAliases, alias, nextBindings, nextVisited);
    };

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (
        !resolvesToUnknown(
          annotation.typeAnnotation,
          lexicalTypeParameterNames(node, context.sourceCode.visitorKeys),
          node,
        )
      ) {
        return;
      }
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        findAlias = collectTypeAliases(node, context.sourceCode.visitorKeys);
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
