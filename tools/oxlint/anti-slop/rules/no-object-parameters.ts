import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;
type TypeBinding =
	| ESTree.TSTypeAliasDeclaration
	| ESTree.TSInterfaceDeclaration
	| ESTree.TSEnumDeclaration
	| ESTree.ClassDeclaration;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

function lexicalContainer(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (
		current.type !== "Program" &&
		current.type !== "BlockStatement" &&
		current.type !== "TSModuleBlock"
	) {
		current = current.parent;
	}
	return current;
}

function bindingName(binding: TypeBinding): string | null {
	return binding.id?.name ?? null;
}

function collectBindings(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	bindings: TypeBinding[],
): void {
	if (
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSEnumDeclaration" ||
		(node.type === "ClassDeclaration" && node.id !== null)
	) {
		bindings.push(node);
	}
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) collectBindings(value, visitorKeys, bindings);
		else if (Array.isArray(value)) {
			for (const child of value) if (isNode(child)) collectBindings(child, visitorKeys, bindings);
		}
	}
}

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
	| ESTree.ArrowFunctionExpression
	| ESTree.Function
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

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
		const bindings: TypeBinding[] = [];

		const visibleAlias = (name: string, site: ESTree.Node) => {
			let current: ESTree.Node | null = site;
			while (current !== null) {
				if (
					current.type === "Program" ||
					current.type === "BlockStatement" ||
					current.type === "TSModuleBlock"
				) {
					const binding = bindings.find(
						(candidate) =>
							bindingName(candidate) === name &&
							lexicalContainer(candidate) === current,
					);
					if (binding !== undefined) {
						return binding.type === "TSTypeAliasDeclaration" &&
							(binding.typeParameters === null || binding.typeParameters === undefined)
							? binding
							: undefined;
					}
				}
				current = current.parent;
			}
			return undefined;
		};

		const resolvesToObject = (
			type: ESTree.TSType,
			shadowedAliases: ReadonlySet<string>,
			visited = new Set<string>(),
		): boolean => {
			if (type.type === "TSObjectKeyword") return true;
			if (type.type === "TSParenthesizedType")
				return resolvesToObject(type.typeAnnotation, shadowedAliases, visited);
			if (type.type === "TSUnionType") {
				return type.types.some((member) =>
					resolvesToObject(member, shadowedAliases, visited),
				);
			}
			if (
				type.type !== "TSTypeReference" ||
				type.typeName.type !== "Identifier" ||
				(type.typeArguments !== null &&
					type.typeArguments !== undefined &&
					type.typeArguments.params.length > 0) ||
				visited.has(type.typeName.name) ||
				shadowedAliases.has(type.typeName.name)
			) {
				return false;
			}
			const alias = visibleAlias(type.typeName.name, type);
			if (alias === undefined) return false;
			const nextVisited = new Set(visited);
			nextVisited.add(type.typeName.name);
			return resolvesToObject(alias.typeAnnotation, shadowedAliases, nextVisited);
		};

		const checkParameters = (node: ParameterOwner) => {
			const shadowedAliases = lexicalTypeParameterNames(
				node,
				context.sourceCode.visitorKeys,
			);
			for (const parameter of node.params) {
				const annotation = parameterAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation, shadowedAliases)) continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: parameterName(parameter, context.sourceCode) },
				});
			}
		};

		return {
			Program(node) {
				bindings.length = 0;
				collectBindings(node, context.sourceCode.visitorKeys, bindings);
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
