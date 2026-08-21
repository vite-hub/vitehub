import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

type TypeBinding =
	| ESTree.TSTypeAliasDeclaration
	| ESTree.TSInterfaceDeclaration
	| ESTree.TSEnumDeclaration
	| ESTree.ClassDeclaration;

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

function lexicalContainer(node: ESTree.Node): ESTree.Node {
	let current: ESTree.Node = node;
	while (
		current.type !== "Program" &&
		current.type !== "BlockStatement" &&
		current.type !== "TSModuleBlock"
	) {
		current = current.parent;
	}
	return current;
}

function referencedAliasName(type: ESTree.TSType): string | null {
	if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
	return type.typeArguments === null ||
		type.typeArguments === undefined ||
		type.typeArguments.params.length === 0
		? type.typeName.name
		: null;
}

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
		},
	},
	createOnce(context) {
		const bindings: TypeBinding[] = [];

		const visibleAlias = (
			name: string,
			site: ESTree.Node,
		): ESTree.TSTypeAliasDeclaration | undefined => {
			if (lexicalTypeParameterNames(site, context.sourceCode.visitorKeys).has(name)) {
				return undefined;
			}
			let current: ESTree.Node | null = site;
			while (current !== null) {
				if (
					current.type === "Program" ||
					current.type === "BlockStatement" ||
					current.type === "TSModuleBlock"
				) {
					const binding = bindings.find(
						(candidate) =>
							bindingName(candidate) === name && lexicalContainer(candidate) === current,
					);
					if (binding !== undefined)
						return binding.type === "TSTypeAliasDeclaration" ? binding : undefined;
				}
				current = current.parent;
			}
			return undefined;
		};

		const resolvesToUnknown = (
			type: ESTree.TSType,
			visited = new Set<ESTree.TSTypeAliasDeclaration>(),
		): boolean => {
			if (type.type === "TSUnknownKeyword") return true;
			if (type.type === "TSUnionType")
				return type.types.some((member) => resolvesToUnknown(member, visited));
			if (type.type === "TSParenthesizedType")
				return resolvesToUnknown(type.typeAnnotation, visited);
			const name = referencedAliasName(type);
			if (name === null) return false;
			const alias = visibleAlias(name, type);
			if (
				alias === undefined ||
				visited.has(alias) ||
				(alias.typeParameters !== null && alias.typeParameters !== undefined)
			) {
				return false;
			}
			const nextVisited = new Set(visited);
			nextVisited.add(alias);
			return resolvesToUnknown(alias.typeAnnotation, nextVisited);
		};

		return {
			Program(node) {
				bindings.length = 0;
				collectBindings(node, context.sourceCode.visitorKeys, bindings);
			},
			TSTypeAliasDeclaration(alias) {
				if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias]))) return;
				context.report({
					node: alias.id,
					messageId: "unknownAlias",
					data: { alias: alias.id.name },
				});
			},
		};
	},
});
