import type { ESTree } from "@oxlint/plugins";

import { lexicalTypeParameterNames } from "./lexical-type-parameters.ts";
import {
	visibleTypeBindingForName,
	type TypeBinding,
	type VisitorKeys,
} from "./lexical-type-bindings.ts";

type Substitution = {
	readonly substitutions: Substitutions;
	readonly type: ESTree.TSType;
};

type Substitutions = ReadonlyMap<string, Substitution>;

function aliasSubstitutions(
	alias: ESTree.TSTypeAliasDeclaration,
	typeArguments: ESTree.TSTypeParameterInstantiation | null | undefined,
	outer: Substitutions,
): Substitutions | null {
	const next = new Map<string, Substitution>();
	const parameters = alias.typeParameters?.params ?? [];
	const arguments_ = typeArguments?.params ?? [];
	for (const [index, parameter] of parameters.entries()) {
		const suppliedArgument = arguments_[index];
		const argument = suppliedArgument ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		// Explicit arguments resolve at the call site. Defaults can reference earlier parameters.
		next.set(parameter.name.name, {
			substitutions: suppliedArgument === undefined ? new Map(next) : outer,
			type: argument,
		});
	}
	return next;
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
	if (type.type !== "TSTypeReference") return false;

	const name = type.typeName.type === "Identifier" ? type.typeName.name : null;
	const binding = visibleTypeBindingForName(type.typeName, type, bindings);
	if (name === null) {
		const alias = binding?.type === "TSTypeAliasDeclaration" ? binding : undefined;
		if (alias === undefined || visited.has(alias)) return false;
		const nextSubstitutions = aliasSubstitutions(alias, type.typeArguments, substitutions);
		if (nextSubstitutions === null) return false;
		const nextVisited = new Set(visited);
		nextVisited.add(alias);
		return resolvesThroughTypeAliases(
			alias.typeAnnotation,
			bindings,
			visitorKeys,
			matches,
			transparentBuiltIns,
			nextSubstitutions,
			nextVisited,
		);
	}
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return substitution.type !== type && resolvesThroughTypeAliases(
			substitution.type,
			bindings,
			visitorKeys,
			matches,
			transparentBuiltIns,
			substitution.substitutions,
			visited,
		);
	}

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

	const nextSubstitutions = aliasSubstitutions(alias, type.typeArguments, substitutions);
	if (nextSubstitutions === null) return false;
	const nextVisited = new Set(visited);
	nextVisited.add(alias);
	return resolvesThroughTypeAliases(
		alias.typeAnnotation, bindings, visitorKeys, matches, transparentBuiltIns, nextSubstitutions, nextVisited,
	);
}
