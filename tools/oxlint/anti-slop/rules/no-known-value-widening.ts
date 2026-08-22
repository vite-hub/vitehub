import { defineRule } from "@oxlint/plugins";

import {
	classifyWideningTarget,
	createTypeEnvironment,
	typeEnvironmentAt,
	isKnownEvidenceExpression,
	type TypeEnvironment,
	type WideningTarget,
} from "../shared/dictionary-types.ts";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type FunctionExpression = ESTree.ArrowFunctionExpression | ESTree.Function;

type AnnotatedClassField = ESTree.AccessorProperty | ESTree.PropertyDefinition;

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference,
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
		? definition.node
		: null;
}

function isStableConstVariable(variable: Variable, declarator: ESTree.VariableDeclarator): boolean {
	return (
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		variable.references.every((reference) => reference.init || !reference.isWrite())
	);
}

function hasKnownEvidence(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	visitedVariables = new Set<Variable>(),
): boolean {
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.type === "ConditionalExpression") {
		return (
			hasKnownEvidence(sourceCode, unwrapped.consequent, new Set(visitedVariables)) &&
			hasKnownEvidence(sourceCode, unwrapped.alternate, new Set(visitedVariables))
		);
	}
	if (isKnownEvidenceExpression(unwrapped)) return true;
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	const nextVisited = new Set(visitedVariables);
	nextVisited.add(variable);
	return hasKnownEvidence(sourceCode, declarator.init, nextVisited);
}

function annotationTarget(
	annotation: ESTree.TSTypeAnnotation | null | undefined,
	environment: TypeEnvironment,
): WideningTarget | null {
	return annotation === null || annotation === undefined
		? null
		: classifyWideningTarget(annotation.typeAnnotation, environment);
}

function enclosingFunction(node: ESTree.Node): FunctionExpression | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function sourceKeyName(sourceCode: SourceCode, key: ESTree.PropertyKey): string {
	if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return sourceCode.getText(key);
}

function stableKeyName(key: ESTree.PropertyKey, computed: boolean): string | null {
	if (!computed && (key.type === "Identifier" || key.type === "PrivateIdentifier")) {
		return key.name;
	}
	return key.type === "Literal" &&
		(typeof key.value === "string" || typeof key.value === "number")
		? String(key.value)
		: null;
}

function enclosingThisClassContext(
	node: ESTree.Node,
): { readonly body: ESTree.ClassBody; readonly static: boolean } | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null) {
		if (current.type === "StaticBlock") {
			return current.parent.type === "ClassBody"
				? { body: current.parent, static: true }
				: null;
		}
		if (
			current.type === "MethodDefinition" ||
			current.type === "PropertyDefinition" ||
			current.type === "AccessorProperty"
		) {
			return current.parent.type === "ClassBody"
				? { body: current.parent, static: current.static }
				: null;
		}
		if (current.type === "FunctionExpression") {
			if (current.parent.type === "MethodDefinition") {
				current = current.parent;
				continue;
			}
			return null;
		}
		if (current.type === "FunctionDeclaration" || current.type === "ClassBody") {
			return null;
		}
		current = current.parent;
	}
	return null;
}

function annotatedThisField(
	member: ESTree.MemberExpression,
): AnnotatedClassField | null {
	if (member.object.type !== "ThisExpression") return null;
	const name = stableKeyName(member.property, member.computed);
	if (name === null) return null;
	const owner = enclosingThisClassContext(member);
	if (owner === null) return null;
	for (const element of owner.body.body) {
		if (
			(element.type !== "PropertyDefinition" &&
				element.type !== "TSAbstractPropertyDefinition" &&
				element.type !== "AccessorProperty" &&
				element.type !== "TSAbstractAccessorProperty") ||
			element.static !== owner.static ||
			stableKeyName(element.key, element.computed) !== name
		) {
			continue;
		}
		return element;
	}
	return null;
}

function functionName(sourceCode: SourceCode, owner: FunctionExpression | null): string {
	if (owner === null) return "anonymous function";
	if (owner.id !== null) return owner.id.name;
	const parent = owner.parent;
	if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return parent.id.name;
	if (parent.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
	return "anonymous function";
}

function isEmptyObjectExpression(expression: ESTree.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}

function isDictionaryAccumulatorTarget(destination: WideningTarget): boolean {
	return destination.kind === "open dictionary" || destination.kind === "generic container";
}

function hasParentAssertion(node: ESTree.Node): boolean {
	return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

function directParameterOwner(node: ESTree.AssignmentPattern): FunctionExpression | null {
	const parameter =
		node.parent.type === "TSParameterProperty" ? node.parent : node;
	const owner = parameter.parent;
	if (
		owner.type !== "ArrowFunctionExpression" &&
		owner.type !== "FunctionDeclaration" &&
		owner.type !== "FunctionExpression"
	) {
		return null;
	}
	return owner.params.includes(parameter) ? owner : null;
}

function bindingAnnotation(
	pattern: ESTree.BindingPattern,
): ESTree.TSTypeAnnotation | null | undefined {
	if (pattern.type === "AssignmentPattern") return bindingAnnotation(pattern.left);
	return pattern.typeAnnotation;
}

function bindingName(pattern: ESTree.BindingPattern): string {
	return pattern.type === "Identifier" ? pattern.name : "parameter";
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWideningRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
		},
		messages: {
			widening:
				"The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const reportFlow = (
			expression: ESTree.Expression,
			destination: WideningTarget | null,
			subject: string,
		) => {
			if (destination === null) return;
			if (
				isDictionaryAccumulatorTarget(destination) &&
				isEmptyObjectExpression(expression)
			) {
				return;
			}
			if (!hasKnownEvidence(context.sourceCode, expression)) return;
			context.report({
				node: expression,
				messageId: "widening",
				data: { subject, target: destination.kind },
			});
		};

		const targetFromAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined) =>
			environment === null || annotation === null || annotation === undefined
				? null
				: annotationTarget(annotation, typeEnvironmentAt(environment, annotation));

		return {
			Program(node) {
				environment = createTypeEnvironment(node, context.sourceCode.visitorKeys);
			},
			VariableDeclarator(node) {
				if (node.init === null || node.id.type !== "Identifier") return;
				reportFlow(
					node.init,
					targetFromAnnotation(node.id.typeAnnotation),
					`binding \`${node.id.name}\``,
				);
			},
			PropertyDefinition(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AccessorProperty(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AssignmentPattern(node) {
				if (directParameterOwner(node) === null) return;
				reportFlow(
					node.right,
					targetFromAnnotation(bindingAnnotation(node.left)),
					`parameter \`${bindingName(node.left)}\``,
				);
			},
			AssignmentExpression(node) {
				if (node.operator !== "=") return;
				if (node.left.type === "MemberExpression") {
					const field = annotatedThisField(node.left);
					if (field === null) return;
					reportFlow(
						node.right,
						targetFromAnnotation(field.typeAnnotation),
						`property \`${sourceKeyName(context.sourceCode, field.key)}\``,
					);
					return;
				}
				if (node.left.type !== "Identifier") return;
				const variable = resolveVariable(context.sourceCode, node.left);
				if (variable === null) return;
				const declarator = variableDeclarator(variable);
				if (declarator === null || declarator.id.type !== "Identifier") return;
				reportFlow(
					node.right,
					targetFromAnnotation(declarator.id.typeAnnotation),
					`binding \`${declarator.id.name}\``,
				);
			},
			ReturnStatement(node) {
				if (node.argument === null) return;
				const owner = enclosingFunction(node);
				reportFlow(
					node.argument,
					targetFromAnnotation(owner?.returnType),
					`return value of \`${functionName(context.sourceCode, owner)}\``,
				);
			},
			ArrowFunctionExpression(node) {
				if (node.body.type === "BlockStatement") return;
				reportFlow(
					node.body,
					targetFromAnnotation(node.returnType),
					`return value of \`${functionName(context.sourceCode, node)}\``,
				);
			},
			TSAsExpression(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(
						node.typeAnnotation,
						typeEnvironmentAt(environment, node.typeAnnotation),
					),
					"assertion",
				);
			},
			TSTypeAssertion(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					classifyWideningTarget(
						node.typeAnnotation,
						typeEnvironmentAt(environment, node.typeAnnotation),
					),
					"assertion",
				);
			},
		};
	},
});
