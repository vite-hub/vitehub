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

function visibleNamespacePaths(
	name: string,
	site: ESTree.Node,
	bindings: readonly TypeBinding[],
	visited: ReadonlySet<TypeBinding> = new Set(),
): readonly (readonly string[])[] {
	return visibleTypeBindings(name, site, bindings).flatMap((binding) => {
		if (visited.has(binding)) return [];
		if (binding.type === "TSModuleDeclaration") {
			const enclosingPath = enclosingNamespacePath(binding);
			return enclosingPath === null ? [] : [[...enclosingPath, name]];
		}
		if (
			binding.type !== "TSImportEqualsDeclaration" ||
			binding.moduleReference.type === "TSExternalModuleReference"
		) {
			return [];
		}
		const target = qualifiedTypeNameParts(binding.moduleReference);
		if (target === null || target.length === 0) return [];
		const [targetRoot, ...targetRest] = target;
		if (targetRoot === undefined) return [];
		const nextVisited = new Set(visited);
		nextVisited.add(binding);
		return visibleNamespacePaths(targetRoot, binding, bindings, nextVisited).map(
			(path) => [...path, ...targetRest],
		);
	});
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
	return parts === null ? undefined : visibleTypeBindingForParts(parts, site, bindings);
}

export function visibleTypeBindingForParts(
	parts: readonly string[],
	site: ESTree.Node,
	bindings: readonly TypeBinding[],
): TypeBinding | undefined {
	if (parts.length === 0) return undefined;
	if (parts.length === 1) return visibleTypeBinding(parts[0] ?? "", site, bindings);
	const root = parts[0];
	const leaf = parts.at(-1);
	if (root === undefined || leaf === undefined) return undefined;
	const visibleRootPaths = visibleNamespacePaths(root, site, bindings);
	if (visibleRootPaths.length === 0) return undefined;
	const namespaceRest = parts.slice(1, -1);
	return bindings.find((binding) => {
		if (typeBindingName(binding) !== leaf) return false;
		const path = enclosingNamespacePath(binding);
		if (path === null) return false;
		return visibleRootPaths.some((rootPath) => {
			const targetPath = [...rootPath, ...namespaceRest];
			return (
				path.length === targetPath.length &&
				path.every((part, index) => part === targetPath[index])
			);
		});
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
