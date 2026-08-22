import { defineRule } from "@oxlint/plugins";
import type { ESTree, Variable } from "@oxlint/plugins";

import {
  classifyUnsafeDictionary,
  classifyWideningTarget,
  createTypeEnvironment,
  typeEnvironmentAt,
} from "../shared/dictionary-types.ts";

import type { TypeEnvironment } from "../shared/dictionary-types.ts";
import type { TypeBinding } from "../shared/lexical-type-bindings.ts";
import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";
import {
  visibleTypeBindingsForName,
  visibleTypeBindingsForParts,
} from "../shared/lexical-type-bindings.ts";
import { resolvesThroughTypeAliases } from "../shared/type-alias-resolution.ts";

type BroadTypeKind = "top" | "object" | "record";

const transparentBroadTypeWrappers = new Set([
  "NonNullable",
  "Partial",
  "Readonly",
  "Required",
]);

type KnownValueEvidence = {
  readonly type: ESTree.TSType | null;
};

function environmentAt(
  environment: TypeEnvironment,
  node: ESTree.Node,
): TypeEnvironment {
  return typeEnvironmentAt(environment, node);
}

const functionBoundaryTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function unwrapExpressionParentheses(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) current = current.expression;
  return current;
}

function unwrapTypeParentheses(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation;
  return current;
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isUnknownOrAnyType(type: ESTree.TSType): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

function isBuiltInType(environment: TypeEnvironment, name: string): boolean {
  return !environment.shadowedBuiltIns.has(name);
}

function isBroadRecordKeyType(type: ESTree.TSType, environment: TypeEnvironment): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every((member) => isBroadRecordKeyType(member, environment));
  }
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === "PropertyKey" &&
    isBuiltInType(environment, "PropertyKey")
  );
}

function isBroadRecordType(type: ESTree.TSType, environment: TypeEnvironment): boolean {
  const unwrapped = unwrapTypeParentheses(type);

  if (unwrapped.type === "TSTypeReference") {
    if (typeReferenceName(unwrapped) === "Readonly" && isBuiltInType(environment, "Readonly")) {
      const [inner] = unwrapped.typeArguments?.params ?? [];
      return inner !== undefined && isBroadRecordType(inner, environment);
    }

    if (
      typeReferenceName(unwrapped) !== "Record" ||
      !isBuiltInType(environment, "Record")
    ) {
      return false;
    }
    const parameters = unwrapped.typeArguments?.params ?? [];
    return (
      parameters.length === 2 &&
      parameters[0] !== undefined &&
      parameters[1] !== undefined &&
      isBroadRecordKeyType(parameters[0], environment) &&
      isUnknownOrAnyType(parameters[1])
    );
  }

  if (unwrapped.type !== "TSTypeLiteral" || unwrapped.members.length !== 1) return false;
  const [member] = unwrapped.members;
  const [parameter] = member?.type === "TSIndexSignature" ? member.parameters : [];
  return (
    member?.type === "TSIndexSignature" &&
    member.parameters.length === 1 &&
    parameter !== undefined &&
    isBroadRecordKeyType(parameter.typeAnnotation.typeAnnotation, environment) &&
    isUnknownOrAnyType(member.typeAnnotation.typeAnnotation)
  );
}

function broadTypeKind(type: ESTree.TSType, environment: TypeEnvironment): BroadTypeKind | null {
  const unwrapped = unwrapTypeParentheses(type);
  if (
    resolvesThroughTypeAliases(
      unwrapped,
      environment.typeBindings,
      environment.visitorKeys,
      (candidate) => unwrapTypeParentheses(candidate).type === "TSAnyKeyword",
      transparentBroadTypeWrappers,
    )
  ) {
    return "top";
  }
  const widening = classifyWideningTarget(unwrapped, environment);
  if (widening?.kind === "unknown") return "top";
  if (widening?.kind === "object") return "object";
  if (isBroadRecordType(unwrapped, environment)) return "record";
  const dictionary = classifyUnsafeDictionary(unwrapped, environment);
  return dictionary?.unsafeValue === "unknown" || dictionary?.unsafeValue === "any"
    ? "record"
    : null;
}

function assertedExpression(
  node: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
): ESTree.Expression {
  return unwrapExpressionParentheses(node.expression);
}

function assertionFromExpression(
  expression: ESTree.Expression,
): ESTree.TSAsExpression | ESTree.TSTypeAssertion | null {
  const unwrapped = unwrapExpressionParentheses(expression);
  return unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion"
    ? unwrapped
    : null;
}

function normalizedTypeText(sourceText: string, type: ESTree.TSType): string {
  return sourceText.slice(type.start, type.end).replaceAll(/\s+/gu, "");
}

function typesHaveSameSyntax(
  sourceText: string,
  left: ESTree.TSType | null,
  right: ESTree.TSType,
): boolean {
  return (
    left !== null &&
    normalizedTypeText(sourceText, unwrapTypeParentheses(left)) ===
      normalizedTypeText(sourceText, unwrapTypeParentheses(right))
  );
}

type ObjectTypeSubstitution = {
  readonly substitutions: ObjectTypeSubstitutions;
  readonly type: ESTree.TSType;
};

type ObjectTypeSubstitutions = ReadonlyMap<string, ObjectTypeSubstitution>;

function objectTypeAliasSubstitutions(
  alias: ESTree.TSTypeAliasDeclaration,
  typeArguments: ESTree.TSTypeParameterInstantiation | null | undefined,
  outer: ObjectTypeSubstitutions,
): ObjectTypeSubstitutions | null {
  const next = new Map<string, ObjectTypeSubstitution>();
  const parameters = alias.typeParameters?.params ?? [];
  const arguments_ = typeArguments?.params ?? [];
  for (const [index, parameter] of parameters.entries()) {
    const suppliedArgument = arguments_[index];
    const argument = suppliedArgument ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    next.set(parameter.name.name, {
      substitutions: suppliedArgument === undefined ? new Map(next) : outer,
      type: argument,
    });
  }
  return next;
}

function classHasObjectMembers(binding: {
  readonly body: ESTree.ClassBody;
}): boolean {
  return binding.body.body.some((member) => {
    if (member.type === "StaticBlock") return false;
    if (member.type !== "TSIndexSignature" && member.static) return false;
    return member.type !== "MethodDefinition" || member.kind !== "constructor";
  });
}

type ObjectDeclarationBinding = Extract<
  TypeBinding,
  { readonly type: "ClassDeclaration" | "TSInterfaceDeclaration" }
>;

function heritageExpressionParts(expression: ESTree.Expression): readonly string[] | null {
  if (expression.type === "Identifier") return [expression.name];
  if (expression.type !== "MemberExpression" || expression.object.type === "Super") return null;
  const object = heritageExpressionParts(expression.object);
  if (object === null) return null;
  const property = expression.computed
    ? expression.property.type === "Literal" && typeof expression.property.value === "string"
      ? expression.property.value
      : null
    : expression.property.type === "Identifier"
      ? expression.property.name
      : null;
  return property === null ? null : [...object, property];
}

function bindingHasObjectMembers(
  binding: ObjectDeclarationBinding,
  environment: TypeEnvironment,
  resolvingDeclarations: ReadonlySet<ObjectDeclarationBinding>,
  resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): boolean {
  if (resolvingDeclarations.has(binding)) return false;
  const nextResolving = new Set(resolvingDeclarations);
  nextResolving.add(binding);
  if (binding.type === "TSInterfaceDeclaration") {
    if (binding.body.body.length > 0) return true;
    return binding.extends.some((heritage: ESTree.TSInterfaceHeritage) =>
      heritageHasObjectMembers(
        heritage.expression,
        heritage.typeArguments,
        environment,
        nextResolving,
        resolvingAliases,
      ),
    );
  }
  if (classHasObjectMembers(binding)) return true;
  return (
    binding.superClass !== null &&
    heritageHasObjectMembers(
      binding.superClass,
      binding.superTypeArguments,
      environment,
      nextResolving,
      resolvingAliases,
    )
  );
}

function heritageHasObjectMembers(
  expression: ESTree.Expression,
  typeArguments: ESTree.TSTypeParameterInstantiation | null | undefined,
  environment: TypeEnvironment,
  resolvingDeclarations: ReadonlySet<ObjectDeclarationBinding>,
  resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): boolean {
  const parts = heritageExpressionParts(expression);
  if (parts === null) return false;
  return visibleTypeBindingsForParts(parts, expression, environment.typeBindings).some(
    (binding) => {
      if (binding.type === "TSInterfaceDeclaration" || binding.type === "ClassDeclaration") {
        return bindingHasObjectMembers(
          binding,
          environment,
          resolvingDeclarations,
          resolvingAliases,
        );
      }
      if (binding.type !== "TSTypeAliasDeclaration" || resolvingAliases.has(binding)) {
        return false;
      }
      const substitutions = objectTypeAliasSubstitutions(binding, typeArguments, new Map());
      if (substitutions === null) return false;
      const nextResolvingAliases = new Set(resolvingAliases);
      nextResolvingAliases.add(binding);
      return isDefinitelyObjectType(
        binding.typeAnnotation,
        environment,
        substitutions,
        nextResolvingAliases,
        resolvingDeclarations,
      );
    },
  );
}

function isDefinitelyObjectType(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: ObjectTypeSubstitutions = new Map(),
  resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration> = new Set(),
  resolvingDeclarations: ReadonlySet<ObjectDeclarationBinding> = new Set(),
): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  switch (unwrapped.type) {
    case "TSArrayType":
    case "TSConstructorType":
    case "TSFunctionType":
    case "TSMappedType":
    case "TSObjectKeyword":
    case "TSTupleType":
      return true;
    case "TSTypeLiteral":
      return unwrapped.members.length > 0;
    case "TSIntersectionType":
      return unwrapped.types.every((member) =>
        isDefinitelyObjectType(
          member,
          environment,
          substitutions,
          resolvingAliases,
          resolvingDeclarations,
        ),
      );
    case "TSTypeOperator":
      return (
        unwrapped.operator === "readonly" &&
        isDefinitelyObjectType(
          unwrapped.typeAnnotation,
          environment,
          substitutions,
          resolvingAliases,
          resolvingDeclarations,
        )
      );
    case "TSTypeReference": {
      const name = typeReferenceName(unwrapped);
      const substitution = name === null ? undefined : substitutions.get(name);
      if (substitution !== undefined) {
        return isDefinitelyObjectType(
          substitution.type,
          environment,
          substitution.substitutions,
          resolvingAliases,
          resolvingDeclarations,
        );
      }
      if (
        name !== null &&
        lexicalTypeParameterNames(unwrapped, environment.visitorKeys).has(name)
      ) {
        return false;
      }
      const bindings = visibleTypeBindingsForName(
        unwrapped.typeName,
        unwrapped,
        environment.typeBindings,
      );
      const interfaces = bindings.filter(
        (binding): binding is ESTree.TSInterfaceDeclaration =>
          binding.type === "TSInterfaceDeclaration",
      );
      if (
        interfaces.some((binding) =>
          bindingHasObjectMembers(
            binding,
            environment,
            resolvingDeclarations,
            resolvingAliases,
          ),
        )
      ) {
        return true;
      }
      const classBinding = bindings.find(
        (binding) => binding.type === "ClassDeclaration",
      );
      if (
        classBinding !== undefined &&
        bindingHasObjectMembers(
          classBinding,
          environment,
          resolvingDeclarations,
          resolvingAliases,
        )
      ) {
        return true;
      }
      const binding = bindings.find(
        (candidate) => candidate.type === "TSTypeAliasDeclaration",
      );
      if (binding?.type !== "TSTypeAliasDeclaration" || resolvingAliases.has(binding)) {
        return false;
      }
      const nextSubstitutions = objectTypeAliasSubstitutions(
        binding,
        unwrapped.typeArguments,
        substitutions,
      );
      if (nextSubstitutions === null) return false;
      const nextResolving = new Set(resolvingAliases);
      nextResolving.add(binding);
      return isDefinitelyObjectType(
        binding.typeAnnotation,
        environment,
        nextSubstitutions,
        nextResolving,
        resolvingDeclarations,
      );
    }
    default:
      return false;
  }
}

function isDefinitelyNarrowerRecordType(
  type: ESTree.TSType,
  environment: TypeEnvironment,
): boolean {
  const unwrapped = unwrapTypeParentheses(type);
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type !== "TSIndexSignature");
  }

  if (unwrapped.type !== "TSTypeReference") return false;
  if (typeReferenceName(unwrapped) === "Readonly" && isBuiltInType(environment, "Readonly")) {
    const [inner] = unwrapped.typeArguments?.params ?? [];
    return inner !== undefined && isDefinitelyNarrowerRecordType(inner, environment);
  }
  if (typeReferenceName(unwrapped) !== "Record" || !isBuiltInType(environment, "Record")) {
    return false;
  }

  const parameters = unwrapped.typeArguments?.params ?? [];
  return (
    parameters.length === 2 && parameters[1] !== undefined && !isUnknownOrAnyType(parameters[1])
  );
}

function functionBoundary(node: ESTree.Node): ESTree.Node | null {
  let current = node.parent;
  while (current !== null && current.type !== "Program") {
    if (functionBoundaryTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function resolvedVariableForIdentifier(
  scopes: readonly {
    readonly references: readonly {
      readonly identifier: ESTree.Node;
      readonly resolved: Variable | null;
    }[];
  }[],
  identifier: ESTree.IdentifierReference,
): Variable | null {
  for (const scope of scopes) {
    const reference = scope.references.find(
      (candidate) =>
        candidate.identifier.start === identifier.start &&
        candidate.identifier.end === identifier.end,
    );
    if (reference !== undefined) return reference.resolved;
  }
  return null;
}

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  for (const definition of variable.defs) {
    if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
      return definition.node;
    }
  }
  return null;
}

function knownValueEvidence(
  expression: ESTree.Expression,
  scopes: Parameters<typeof resolvedVariableForIdentifier>[0],
  boundary: ESTree.Node | null,
  visitedVariables: ReadonlySet<Variable>,
  environmentAtNode: (node: ESTree.Node) => TypeEnvironment,
  sourceText: string,
): KnownValueEvidence | null {
  const unwrapped = unwrapExpressionParentheses(expression);

  if (unwrapped.type === "TSAsExpression" || unwrapped.type === "TSTypeAssertion") {
    if (broadTypeKind(unwrapped.typeAnnotation, environmentAtNode(unwrapped)) !== null) return null;
    return { type: unwrapped.typeAnnotation };
  }

  if (
    unwrapped.type === "Literal" ||
    unwrapped.type === "TemplateLiteral" ||
    unwrapped.type === "UnaryExpression" ||
    unwrapped.type === "BinaryExpression"
  ) {
    return { type: null };
  }

  if (unwrapped.type === "ConditionalExpression" || unwrapped.type === "LogicalExpression") {
    const left =
      unwrapped.type === "ConditionalExpression" ? unwrapped.consequent : unwrapped.left;
    const right =
      unwrapped.type === "ConditionalExpression" ? unwrapped.alternate : unwrapped.right;
    const consequent = knownValueEvidence(
      left,
      scopes,
      boundary,
      new Set(visitedVariables),
      environmentAtNode,
      sourceText,
    );
    if (consequent === null) return null;
    const alternate = knownValueEvidence(
      right,
      scopes,
      boundary,
      new Set(visitedVariables),
      environmentAtNode,
      sourceText,
    );
    if (alternate === null) return null;
    return {
      type:
        alternate.type !== null &&
        typesHaveSameSyntax(sourceText, consequent.type, alternate.type)
          ? consequent.type
          : null,
    };
  }

  if (
    unwrapped.type === "ArrayExpression" ||
    unwrapped.type === "ArrowFunctionExpression" ||
    unwrapped.type === "ClassExpression" ||
    unwrapped.type === "FunctionExpression" ||
    unwrapped.type === "NewExpression" ||
    unwrapped.type === "ObjectExpression"
  ) {
    return { type: null };
  }

  if (unwrapped.type !== "Identifier") return null;
  const variable = resolvedVariableForIdentifier(scopes, unwrapped);
  if (variable === null || visitedVariables.has(variable)) return null;

  const annotatedIdentifier = variable.identifiers.find(
    (identifier) => identifier.typeAnnotation !== null && identifier.typeAnnotation !== undefined,
  );
  const annotation = annotatedIdentifier?.typeAnnotation?.typeAnnotation;
  if (annotation !== undefined && annotatedIdentifier !== undefined) {
    if (
      functionBoundary(annotatedIdentifier) !== boundary ||
      broadTypeKind(annotation, environmentAtNode(annotatedIdentifier)) !== null
    ) {
      return null;
    }
    return { type: annotation };
  }

  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init) ||
    functionBoundary(declarator) !== boundary
  ) {
    return null;
  }

  return knownValueEvidence(
    declarator.init,
    scopes,
    boundary,
    new Set([...visitedVariables, variable]),
    environmentAtNode,
    sourceText,
  );
}

function widenedBinding(
  variable: Variable,
  scopes: Parameters<typeof resolvedVariableForIdentifier>[0],
  environmentAtNode: (node: ESTree.Node) => TypeEnvironment,
  sourceText: string,
): {
  readonly broadKind: BroadTypeKind;
  readonly evidence: KnownValueEvidence;
  readonly declaredAt: number;
  readonly boundary: ESTree.Node | null;
} | null {
  const declarator = variableDeclarator(variable);
  if (
    declarator === null ||
    declarator.parent.type !== "VariableDeclaration" ||
    declarator.parent.kind !== "const" ||
    declarator.id.type !== "Identifier" ||
    declarator.init === null ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return null;
  }

  const boundary = functionBoundary(declarator);
  const declaredType = declarator.id.typeAnnotation?.typeAnnotation;
  const initializerAssertion = assertionFromExpression(declarator.init);
  const initializerBroadKind =
    initializerAssertion === null
      ? null
      : broadTypeKind(initializerAssertion.typeAnnotation, environmentAtNode(initializerAssertion));
  const declaredBroadKind =
    declaredType === undefined ? null : broadTypeKind(declaredType, environmentAtNode(declarator));
  const broadKind = declaredBroadKind ?? initializerBroadKind;
  if (broadKind === null) return null;

  const originalExpression =
    initializerAssertion !== null && initializerBroadKind !== null
      ? assertedExpression(initializerAssertion)
      : declarator.init;
  const evidence = knownValueEvidence(
    originalExpression,
    scopes,
    boundary,
    new Set([variable]),
    environmentAtNode,
    sourceText,
  );
  return evidence === null ? null : { broadKind, evidence, declaredAt: declarator.end, boundary };
}

function assertionIsNarrower(
  sourceText: string,
  broadKind: BroadTypeKind,
  evidence: KnownValueEvidence,
  assertedType: ESTree.TSType,
  environment: TypeEnvironment,
): boolean {
  if (broadTypeKind(assertedType, environment) !== null) return false;
  if (broadKind === "top") return true;
  if (typesHaveSameSyntax(sourceText, evidence.type, assertedType)) return true;
  if (broadKind === "object") return isDefinitelyObjectType(assertedType, environment);
  return isDefinitelyNarrowerRecordType(assertedType, environment);
}

/** Detect immutable local bindings that erase a known type and are later asserted back to a narrower type. */
export const noWidenThenAssertRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local const flows that explicitly widen a known value before asserting the widened binding to a narrower type.",
    },
    messages: {
      widenThenAssert:
        'Binding "{{name}}" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
    },
  },
  createOnce(context) {
    let scopes: Parameters<typeof resolvedVariableForIdentifier>[0] = [];
    let environment: TypeEnvironment | null = null;

    const checkAssertion = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const expression = assertedExpression(node);
      if (expression.type !== "Identifier") return;

      const variable = resolvedVariableForIdentifier(scopes, expression);
      if (variable === null) return;
      if (environment === null) return;
      const declarator = variableDeclarator(variable);
      if (declarator === null) return;
      const lexicalEnvironment = environmentAt(
        environment,
        node,
      );
      const widened = widenedBinding(
        variable,
        scopes,
        (site) => typeEnvironmentAt(environment, site),
        context.sourceCode.text,
      );
      if (
        widened === null ||
        node.start <= widened.declaredAt ||
        functionBoundary(node) !== widened.boundary ||
        !assertionIsNarrower(
          context.sourceCode.text,
          widened.broadKind,
          widened.evidence,
          node.typeAnnotation,
          lexicalEnvironment,
        )
      ) {
        return;
      }

      context.report({
        node,
        messageId: "widenThenAssert",
        data: { name: expression.name },
      });
    };

    return {
      Program(node) {
        scopes = context.sourceCode.scopeManager.scopes;
        environment = createTypeEnvironment(node, context.sourceCode.visitorKeys);
      },
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
