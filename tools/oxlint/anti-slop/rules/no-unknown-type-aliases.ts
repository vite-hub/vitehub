import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

function collectAliases(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	aliases: ESTree.TSTypeAliasDeclaration[],
): void {
	if (node.type === "TSTypeAliasDeclaration") aliases.push(node);
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) collectAliases(value, visitorKeys, aliases);
		else if (Array.isArray(value)) {
			for (const child of value) if (isNode(child)) collectAliases(child, visitorKeys, aliases);
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
		const aliases: ESTree.TSTypeAliasDeclaration[] = [];

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
					const alias = aliases.find(
						(candidate) =>
							candidate.id.name === name && lexicalContainer(candidate) === current,
					);
					if (alias !== undefined) return alias;
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
				aliases.length = 0;
				collectAliases(node, context.sourceCode.visitorKeys, aliases);
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
