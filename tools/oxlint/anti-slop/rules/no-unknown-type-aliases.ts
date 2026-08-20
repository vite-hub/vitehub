import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";
import { collectTypeAliases } from "../shared/type-aliases.ts";

type TypeBinding = {
	type: ESTree.TSType;
	bindings: ReadonlyMap<string, TypeBinding>;
};

function typeName(type: ESTree.TSTypeName): string {
	return type.type === "Identifier"
		? type.name
		: `${typeName(type.left)}.${type.right.name}`;
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
		let findAlias: ReturnType<typeof collectTypeAliases>;

		const resolvesToUnknown = (
			type: ESTree.TSType,
			from: ESTree.Node,
			bindings: ReadonlyMap<string, TypeBinding> = new Map(),
			visited = new Set<string>(),
		): boolean => {
			if (type.type === "TSUnknownKeyword") return true;
			if (type.type === "TSParenthesizedType")
				return resolvesToUnknown(type.typeAnnotation, from, bindings, visited);
			if (type.type === "TSUnionType")
				return type.types.some((member) => resolvesToUnknown(member, from, bindings, visited));
			if (type.type !== "TSTypeReference") return false;
			const name = typeName(type.typeName);
			const bound = bindings.get(name);
			if (bound !== undefined) {
				return resolvesToUnknown(bound.type, from, bound.bindings, visited);
			}
			if (visited.has(name)) return false;
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
			return resolvesToUnknown(alias.typeAnnotation, alias, nextBindings, nextVisited);
		};

		return {
			Program(node) {
				findAlias = collectTypeAliases(node, context.sourceCode.visitorKeys);
			},
			TSTypeAliasDeclaration(alias) {
				if (!resolvesToUnknown(alias.typeAnnotation, alias, new Map(), new Set([alias.id.name]))) return;
					context.report({
						node: alias.id,
						messageId: "unknownAlias",
						data: { alias: alias.id.name },
					});
			},
		};
	},
});
