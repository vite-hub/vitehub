import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

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
	from: ESTree.Node;
	shadowedAliases: ReadonlySet<string>;
};

function typeName(type: ESTree.TSTypeName): string {
	return type.type === "Identifier"
		? type.name
		: `${typeName(type.left)}.${type.right.name}`;
}

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

function parameterName(parameter: Parameter, sourceCode: SourceCode): string {
	return parameter.type === "Identifier"
		? parameter.name
		: sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
		},
		messages: {
			objectParameter:
				"Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
		},
	},
	createOnce(context) {
		let findAlias: ReturnType<typeof collectTypeAliases>;

		const resolvesToObject = (
			type: ESTree.TSType,
			shadowedAliases: ReadonlySet<string>,
			from: ESTree.Node,
			bindings: ReadonlyMap<string, TypeBinding> = new Map(),
			visited = new Set<string>(),
		): boolean => {
			if (type.type === "TSObjectKeyword") return true;
			if (type.type === "TSParenthesizedType")
				return resolvesToObject(type.typeAnnotation, shadowedAliases, from, bindings, visited);
			if (type.type === "TSUnionType") {
				return type.types.some((member) =>
					resolvesToObject(member, shadowedAliases, from, bindings, visited),
				);
			}
			if (type.type !== "TSTypeReference") {
				return false;
			}
			const name = typeName(type.typeName);
			if (
				visited.has(name) ||
				(shadowedAliases.has(name) && !bindings.has(name))
			) return false;
			const bound = bindings.get(name);
			if (bound !== undefined)
				return resolvesToObject(bound.type, bound.shadowedAliases, bound.from, bound.bindings, visited);
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
					from: arguments_[index] === undefined ? alias : from,
					shadowedAliases: arguments_[index] === undefined
						? lexicalTypeParameterNames(alias, context.sourceCode.visitorKeys)
						: shadowedAliases,
				});
			}
			const nextVisited = new Set(visited);
			nextVisited.add(name);
			return resolvesToObject(
				alias.typeAnnotation,
				lexicalTypeParameterNames(alias, context.sourceCode.visitorKeys),
				alias,
				nextBindings,
				nextVisited,
			);
		};

		const checkParameters = (node: ParameterOwner) => {
			const shadowedAliases = lexicalTypeParameterNames(
				node,
				context.sourceCode.visitorKeys,
			);
			for (const parameter of node.params) {
				const annotation = parameterAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation, shadowedAliases, node)) continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: parameterName(parameter, context.sourceCode) },
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
