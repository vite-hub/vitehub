import type { ESTree } from "@oxlint/plugins";

type AliasScope = ESTree.Program | ESTree.BlockStatement | ESTree.TSModuleBlock;
type VisitorKeys = Readonly<Record<string, readonly string[]>>;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

function isAliasScope(node: ESTree.Node): node is AliasScope {
	return (
		node.type === "Program" || node.type === "BlockStatement" || node.type === "TSModuleBlock"
	);
}

/** Index aliases by lexical scope before rule visitors begin checking contracts. */
export function collectTypeAliases(
	program: ESTree.Program,
	visitorKeys: VisitorKeys,
): (name: string, from: ESTree.Node) => ESTree.TSTypeAliasDeclaration | undefined {
	const aliases = new WeakMap<AliasScope, Map<string, ESTree.TSTypeAliasDeclaration | null>>();

	const visit = (node: ESTree.Node, scope: AliasScope): void => {
		const currentScope = isAliasScope(node) ? node : scope;
		if (
			node.type === "TSTypeAliasDeclaration" ||
			node.type === "TSInterfaceDeclaration" ||
			node.type === "TSEnumDeclaration" ||
			node.type === "TSImportEqualsDeclaration" ||
			node.type === "ClassDeclaration"
		) {
			const names = aliases.get(currentScope) ?? new Map();
			if (node.id !== null) {
				names.set(node.id.name, node.type === "TSTypeAliasDeclaration" ? node : null);
			}
			aliases.set(currentScope, names);
		}
		const record = node as unknown as Readonly<Record<string, unknown>>;
		for (const key of visitorKeys[node.type] ?? []) {
			const value = record[key];
			if (isNode(value)) visit(value, currentScope);
			else if (Array.isArray(value)) {
				for (const child of value) if (isNode(child)) visit(child, currentScope);
			}
		}
	};

	visit(program, program);
	return (name, from) => {
		let current: ESTree.Node | null = from;
		while (current !== null) {
			if (isAliasScope(current)) {
				const names = aliases.get(current);
				if (names?.has(name) === true) return names.get(name) ?? undefined;
			}
			current = current.parent;
		}
		return undefined;
	};
}
