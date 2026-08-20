import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";
import { collectTypeAliases } from "../shared/type-aliases.ts";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
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

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    let findAlias: ReturnType<typeof collectTypeAliases>;
    const containsUnknown = (
      type: ESTree.TSType,
      from: ESTree.Node,
      shadowedAliases: ReadonlySet<string>,
      bindings: ReadonlyMap<string, TypeBinding> = new Map(),
      visited = new Set<string>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType")
        return containsUnknown(type.typeAnnotation, from, shadowedAliases, bindings, visited);
      if (type.type === "TSUnionType")
        return type.types.some((member) =>
          containsUnknown(member, from, shadowedAliases, bindings, visited),
        );
      if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
      const name = type.typeName.name;
      const bound = bindings.get(name);
      if (bound !== undefined)
        return containsUnknown(bound.type, from, shadowedAliases, bound.bindings, visited);
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
        nextBindings.set(parameter.name.name, { type: argument, bindings });
      }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return containsUnknown(alias.typeAnnotation, alias, shadowedAliases, nextBindings, nextVisited);
    };

    const checkParameters = (node: ParameterOwner) => {
      const shadowedAliases = lexicalTypeParameterNames(node, context.sourceCode.visitorKeys);
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (
          annotation === null ||
          annotation === undefined ||
          !containsUnknown(annotation.typeAnnotation, node, shadowedAliases)
        )
          continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (name === "cause") continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      Program(node) {
        findAlias = collectTypeAliases(node, context.sourceCode.visitorKeys);
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
