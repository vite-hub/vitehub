import type { ESTree } from "@oxlint/plugins";

type AliasScope = ESTree.Program | ESTree.BlockStatement | ESTree.TSModuleBlock;
type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export type TypeAliasFinder = {
	(name: string, from: ESTree.Node): ESTree.TSTypeAliasDeclaration | undefined;
	isDeclared(name: string, from: ESTree.Node): boolean;
};

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
): TypeAliasFinder {
	const aliases = new WeakMap<AliasScope, Map<string, ESTree.TSTypeAliasDeclaration | null>>();
	const qualifiedAliases = new Map<string, ESTree.TSTypeAliasDeclaration>();

	const visit = (node: ESTree.Node, scope: AliasScope, namespace: string[] = []): void => {
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
				if (node.type === "TSTypeAliasDeclaration" && namespace.length > 0) {
					qualifiedAliases.set([...namespace, node.id.name].join("."), node);
				}
			}
			aliases.set(currentScope, names);
		}
		const record = node as unknown as Readonly<Record<string, unknown>>;
		for (const key of visitorKeys[node.type] ?? []) {
			const value = record[key];
			const childNamespace =
				node.type === "TSModuleDeclaration" && node.id.type === "Identifier"
					? [...namespace, node.id.name]
					: namespace;
			if (isNode(value)) visit(value, currentScope, childNamespace);
			else if (Array.isArray(value)) {
				for (const child of value) if (isNode(child)) visit(child, currentScope, childNamespace);
			}
		}
	};

	visit(program, program);
	const declaration = (name: string, from: ESTree.Node) => {
		let current: ESTree.Node | null = from;
		while (current !== null) {
			if (isAliasScope(current)) {
				const names = aliases.get(current);
				if (names?.has(name) === true) return { found: true, alias: names.get(name) ?? undefined };
			}
			current = current.parent;
		}
		return { found: false, alias: undefined };
	};
	const find = ((name: string, from: ESTree.Node) => {
		if (name.includes(".")) {
			const [root] = name.split(".");
			if (root !== undefined && declaration(root, from).found) return undefined;
			const namespaces: string[] = [];
			let current: ESTree.Node | null = from;
			while (current !== null) {
				if (current.type === "TSModuleDeclaration" && current.id.type === "Identifier") {
					namespaces.unshift(current.id.name);
				}
				current = current.parent;
			}
			for (let index = namespaces.length; index >= 0; index--) {
				const candidate = [...namespaces.slice(0, index), name].join(".");
				const alias = qualifiedAliases.get(candidate);
				if (alias !== undefined) return alias;
			}
			return undefined;
		}
		return declaration(name, from).alias;
	}) as TypeAliasFinder;
	find.isDeclared = (name, from) => declaration(name, from).found;
	return find;
}
