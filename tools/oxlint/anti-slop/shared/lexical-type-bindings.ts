import type { ESTree } from "@oxlint/plugins";

export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export type TypeBinding =
	| ESTree.TSTypeAliasDeclaration
	| ESTree.TSInterfaceDeclaration
	| ESTree.TSEnumDeclaration
	| ESTree.ClassDeclaration
	| ESTree.TSImportEqualsDeclaration;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

export function typeBindingName(binding: TypeBinding): string | null {
	return binding.type === "TSImportEqualsDeclaration"
		? binding.id.name
		: (binding.id?.name ?? null);
}

export function collectTypeBindings(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
	bindings: TypeBinding[],
): void {
	if (
		node.type === "TSTypeAliasDeclaration" ||
		node.type === "TSInterfaceDeclaration" ||
		node.type === "TSEnumDeclaration" ||
		node.type === "TSImportEqualsDeclaration" ||
		(node.type === "ClassDeclaration" && node.id !== null)
	) {
		bindings.push(node);
	}
	const record = node as unknown as Readonly<Record<string, unknown>>;
	for (const key of visitorKeys[node.type] ?? []) {
		const value = record[key];
		if (isNode(value)) collectTypeBindings(value, visitorKeys, bindings);
		else if (Array.isArray(value)) {
			for (const child of value)
				if (isNode(child)) collectTypeBindings(child, visitorKeys, bindings);
		}
	}
}

export function lexicalTypeContainer(node: ESTree.Node): ESTree.Node {
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

export function visibleTypeBinding(
	name: string,
	site: ESTree.Node,
	bindings: readonly TypeBinding[],
): TypeBinding | undefined {
	let current: ESTree.Node | null = site;
	while (current !== null) {
		if (
			current.type === "Program" ||
			current.type === "BlockStatement" ||
			current.type === "TSModuleBlock"
		) {
			const binding = bindings.find(
				(candidate) =>
					typeBindingName(candidate) === name &&
					lexicalTypeContainer(candidate) === current,
			);
			if (binding !== undefined) return binding;
		}
		current = current.parent;
	}
	return undefined;
}
