import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "./lexical-type-parameters.ts";
import { visibleTypeBinding, type TypeBinding, type VisitorKeys } from "./lexical-type-bindings.ts";

type Substitutions = ReadonlyMap<string, ESTree.TSType>;

function resolvedSubstitution(
	type: ESTree.TSType,
	substitutions: Substitutions,
	resolving = new Set<string>(),
): ESTree.TSType {
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return type;
	const name = type.typeName.name;
	if (resolving.has(name)) return type;
	const substitution = substitutions.get(name);
	if (substitution === undefined) return type;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitution(substitution, substitutions, nextResolving);
}

export function resolvesThroughTypeAliases(
	type: ESTree.TSType,
	bindings: readonly TypeBinding[],
	visitorKeys: VisitorKeys,
	matches: (type: ESTree.TSType) => boolean,
	transparentBuiltIns: ReadonlySet<string> = new Set(),
	substitutions: Substitutions = new Map(),
	visited = new Set<ESTree.TSTypeAliasDeclaration>(),
): boolean {
	if (matches(type)) return true;
	if (type.type === "TSParenthesizedType") {
		return resolvesThroughTypeAliases(
			type.typeAnnotation, bindings, visitorKeys, matches, transparentBuiltIns, substitutions, visited,
		);
	}
	if (type.type === "TSUnionType") {
		return type.types.some((member) =>
			resolvesThroughTypeAliases(
				member, bindings, visitorKeys, matches, transparentBuiltIns, substitutions, visited,
			),
		);
	}
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;

	const name = type.typeName.name;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		const resolved = resolvedSubstitution(substitution, substitutions);
		return resolved !== type && resolvesThroughTypeAliases(
			resolved, bindings, visitorKeys, matches, transparentBuiltIns, substitutions, visited,
		);
	}

	const binding = visibleTypeBinding(name, type, bindings);
	if (
		transparentBuiltIns.has(name) &&
		binding === undefined &&
		!lexicalTypeParameterNames(type, visitorKeys).has(name)
	) {
		const wrapped = type.typeArguments?.params[0];
		return wrapped !== undefined && resolvesThroughTypeAliases(
			wrapped, bindings, visitorKeys, matches, transparentBuiltIns, substitutions, visited,
		);
	}
	const alias = binding?.type === "TSTypeAliasDeclaration" ? binding : undefined;
	if (
		alias === undefined ||
		visited.has(alias) ||
		lexicalTypeParameterNames(type, visitorKeys).has(name)
	) return false;

	const nextSubstitutions = new Map(substitutions);
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	for (const [index, parameter] of parameters.entries()) {
		const suppliedArgument = arguments_[index];
		const argument = suppliedArgument ?? parameter.default;
		if (argument === null || argument === undefined) return false;
		// Resolve in the caller environment before the alias parameter can shadow it.
		nextSubstitutions.set(
			parameter.name.name,
			resolvedSubstitution(argument, suppliedArgument === undefined ? nextSubstitutions : substitutions),
		);
	}
	const nextVisited = new Set(visited);
	nextVisited.add(alias);
	return resolvesThroughTypeAliases(
		alias.typeAnnotation, bindings, visitorKeys, matches, transparentBuiltIns, nextSubstitutions, nextVisited,
	);
}
