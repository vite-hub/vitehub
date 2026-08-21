import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	collectTypeBindings,
	type TypeBinding,
} from "../shared/lexical-type-bindings.ts";
import { resolvesThroughTypeAliases } from "../shared/type-alias-resolution.ts";

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

		return {
			Program(node) {
				bindings.length = 0;
				collectTypeBindings(node, context.sourceCode.visitorKeys, bindings);
			},
			TSTypeAliasDeclaration(alias) {
				if (!resolvesThroughTypeAliases(
					alias.typeAnnotation,
					bindings,
					context.sourceCode.visitorKeys,
					(type) => type.type === "TSUnknownKeyword",
					new Set(),
					new Map(),
					new Set([alias]),
				)) return;
				context.report({
					node: alias.id,
					messageId: "unknownAlias",
					data: { alias: alias.id.name },
				});
			},
		};
	},
});
