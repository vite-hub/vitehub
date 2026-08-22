import type { ESTree } from "@oxlint/plugins";

export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export type TypeBinding =
	| ESTree.TSTypeAliasDeclaration
	| ESTree.TSInterfaceDeclaration
	| ESTree.TSEnumDeclaration
	| ESTree.ClassDeclaration
	| ESTree.TSImportEqualsDeclaration
	| ESTree.TSModuleDeclaration;

function isNode(value: unknown): value is ESTree.Node {
	return typeof value === "object" && value !== null && "type" in value;
}

export function typeBindingName(binding: TypeBinding): string | null {
	return binding.id.type === "Identifier" ? binding.id.name : null;
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
		node.type === "TSModuleDeclaration" ||
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

function qualifiedTypeNameParts(name: ESTree.TSTypeName): readonly string[] | null {
	if (name.type === "Identifier") return [name.name];
	if (name.type !== "TSQualifiedName") return null;
	const left = qualifiedTypeNameParts(name.left);
	return left === null ? null : [...left, name.right.name];
}

function enclosingNamespacePath(binding: TypeBinding): readonly string[] | null {
	const names: string[] = [];
	let current: ESTree.Node | null = binding.parent;
	while (current !== null) {
		if (current.type === "TSModuleBlock") {
			const declaration = current.parent;
			if (
				declaration.type !== "TSModuleDeclaration" ||
				declaration.id.type !== "Identifier"
			) {
				return null;
			}
			names.unshift(declaration.id.name);
		}
		current = current.parent;
	}
	return names;
}

function lexicalTypeContainer(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (
		current.type !== "Program" &&
		current.type !== "BlockStatement" &&
		current.type !== "SwitchStatement" &&
		current.type !== "StaticBlock" &&
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
	return visibleTypeBindings(name, site, bindings)[0];
}

export function visibleTypeBindingForName(
	name: ESTree.TSTypeName,
	site: ESTree.Node,
	bindings: readonly TypeBinding[],
): TypeBinding | undefined {
	const parts = qualifiedTypeNameParts(name);
	if (parts === null || parts.length === 0) return undefined;
	if (parts.length === 1) return visibleTypeBinding(parts[0] ?? "", site, bindings);
	const root = parts[0];
	const leaf = parts.at(-1);
	if (root === undefined || leaf === undefined) return undefined;
	const visibleRoots = visibleTypeBindings(root, site, bindings).filter(
		(binding): binding is ESTree.TSModuleDeclaration =>
			binding.type === "TSModuleDeclaration" && binding.id.type === "Identifier",
	);
	if (visibleRoots.length === 0) return undefined;
	const namespacePath = parts.slice(0, -1);
	return bindings.find((binding) => {
		if (typeBindingName(binding) !== leaf) return false;
		const path = enclosingNamespacePath(binding);
		return (
			path !== null &&
			path.length === namespacePath.length &&
			path.every((part, index) => part === namespacePath[index])
		);
	});
}

export function visibleTypeBindings(
	name: string,
	site: ESTree.Node,
	bindings: readonly TypeBinding[],
): readonly TypeBinding[] {
	let current: ESTree.Node | null = site;
	while (current !== null) {
		if (
			current.type === "Program" ||
			current.type === "BlockStatement" ||
			current.type === "SwitchStatement" ||
			current.type === "StaticBlock" ||
			current.type === "TSModuleBlock"
		) {
			const matches = bindings.filter(
				(candidate) =>
					typeBindingName(candidate) === name &&
					lexicalTypeContainer(candidate) === current,
			);
			if (matches.length > 0) return matches;
		}
		current = current.parent;
	}
	return [];
}
