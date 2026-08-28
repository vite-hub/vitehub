import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isAsExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isComputedPropertyName,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteralLike,
  isSatisfiesExpression,
  isSwitchStatement,
  isTypeAssertionExpression,
  isVariableDeclaration,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type Statement,
  ScriptKind,
  ScriptTarget,
} from "typescript";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const envDeclarationModules = new Set(["@vite-hub/env", "@vite-hub/env/vite", "vite-hub/env"]);

function propertyName(node: Node) {
  if (isIdentifier(node) || isStringLiteralLike(node)) return node.text;
  if (isComputedPropertyName(node) && isStringLiteralLike(node.expression)) {
    return node.expression.text;
  }
}

function isEnvDeclaration(
  node: Node,
  bindings: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): node is CallExpression {
  if (!isCallExpression(node)) return false;
  if (isIdentifier(node.expression)) return bindings.has(node.expression.text);
  if (!isPropertyAccessExpression(node.expression)) return false;

  const owner = node.expression.expression;
  if (isIdentifier(owner)) {
    return (
      (bindings.has(owner.text) && node.expression.name.text === "variable") ||
      (namespaces.has(owner.text) && node.expression.name.text === "env")
    );
  }
  return (
    isPropertyAccessExpression(owner) &&
    isIdentifier(owner.expression) &&
    namespaces.has(owner.expression.text) &&
    owner.name.text === "env" &&
    node.expression.name.text === "variable"
  );
}

function envCalls(source: string) {
  const sourceFile = createSourceFile(
    "documented-env.ts",
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  const calls: CallExpression[] = [];
  const bindings = new Set(["env"]);
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteralLike(statement.moduleSpecifier) ||
      !envDeclarationModules.has(statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    if (isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
    } else if (isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "env") bindings.add(element.name.text);
      }
    }
  }

  function visit(node: Node) {
    if (isEnvDeclaration(node, bindings, namespaces)) {
      calls.push(node);
      return;
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
  return { calls, sourceFile };
}

function sectionObjects(sourceFile: Node) {
  const bindings = new Map<Node, Map<string, Expression | FunctionDeclaration>>();
  const configBindings = new Set(["defineConfig"]);
  const configCombinators = new Set(["mergeConfig"]);
  const configNamespaces = new Set<string>();
  const sections = new Map<Node, "define" | "public">();

  function bindingScope(node: Node) {
    for (let current = node.parent; current; current = current.parent) {
      if (isBlock(current) || isSourceFile(current)) return current;
    }
    return sourceFile;
  }

  function collectBindings(node: Node) {
    if (
      isImportDeclaration(node) &&
      isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "vite" &&
      node.importClause?.namedBindings
    ) {
      const namedBindings = node.importClause.namedBindings;
      if (isNamespaceImport(namedBindings)) {
        configNamespaces.add(namedBindings.name.text);
      } else if (isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === "defineConfig") {
            configBindings.add(element.name.text);
          } else if ((element.propertyName ?? element.name).text === "mergeConfig") {
            configCombinators.add(element.name.text);
          }
        }
      }
    }
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
      const scope = bindingScope(node);
      const scopeBindings = bindings.get(scope) ?? new Map<string, Expression>();
      scopeBindings.set(node.name.text, node.initializer);
      bindings.set(scope, scopeBindings);
    }
    if (isFunctionDeclaration(node) && node.name) {
      const scope = bindingScope(node);
      const scopeBindings =
        bindings.get(scope) ?? new Map<string, Expression | FunctionDeclaration>();
      scopeBindings.set(node.name.text, node);
      bindings.set(scope, scopeBindings);
    }
    forEachChild(node, collectBindings);
  }

  type ObjectResolution = {
    complete: boolean;
    objects: ObjectLiteralExpression[];
  };

  function resolveObjectsDetailed(
    expression: Expression | FunctionDeclaration,
    seen = new Set<string>(),
  ): ObjectResolution {
    if (
      isParenthesizedExpression(expression) ||
      isAsExpression(expression) ||
      isSatisfiesExpression(expression) ||
      isTypeAssertionExpression(expression) ||
      isNonNullExpression(expression)
    ) {
      return resolveObjectsDetailed(expression.expression, seen);
    }
    if (isConditionalExpression(expression)) {
      const whenTrue = resolveObjectsDetailed(expression.whenTrue, new Set(seen));
      const whenFalse = resolveObjectsDetailed(expression.whenFalse, new Set(seen));
      return {
        complete: whenTrue.complete && whenFalse.complete,
        objects: [...whenTrue.objects, ...whenFalse.objects],
      };
    }
    if (isObjectLiteralExpression(expression)) return { complete: true, objects: [expression] };
    if (
      isCallExpression(expression) &&
      ((isIdentifier(expression.expression) && configCombinators.has(expression.expression.text)) ||
        (isPropertyAccessExpression(expression.expression) &&
          isIdentifier(expression.expression.expression) &&
          configNamespaces.has(expression.expression.expression.text) &&
          expression.expression.name.text === "mergeConfig"))
    ) {
      const resolutions = expression.arguments.map((argument) =>
        resolveObjectsDetailed(argument, new Set(seen)),
      );
      return {
        complete: resolutions.length > 0 && resolutions.every(({ complete }) => complete),
        objects: resolutions.flatMap(({ objects }) => objects),
      };
    }
    if (
      isCallExpression(expression) &&
      isIdentifier(expression.expression) &&
      !seen.has(expression.expression.text)
    ) {
      let factory: Expression | FunctionDeclaration | undefined;
      for (let current: Node | undefined = expression; current; current = current.parent) {
        if (!isBlock(current) && !isSourceFile(current)) continue;
        factory = bindings.get(current)?.get(expression.expression.text);
        if (factory) break;
      }
      return factory
        ? resolveObjectsDetailed(factory, new Set(seen).add(expression.expression.text))
        : { complete: false, objects: [] };
    }
    if (
      isArrowFunction(expression) ||
      isFunctionExpression(expression) ||
      isFunctionDeclaration(expression)
    ) {
      if (!expression.body) return { complete: false, objects: [] };
      if (!isBlock(expression.body)) return resolveObjectsDetailed(expression.body, seen);

      const body = expression.body;
      const returned: Expression[] = [];
      let hasEmptyReturn = false;
      function collectReturns(node: Node) {
        if (
          node !== body &&
          (isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node))
        ) {
          return;
        }
        if (isReturnStatement(node)) {
          if (node.expression) returned.push(node.expression);
          else hasEmptyReturn = true;
          return;
        }
        forEachChild(node, collectReturns);
      }
      collectReturns(body);
      const resolutions = returned.map((value) => resolveObjectsDetailed(value, new Set(seen)));

      function alwaysReturns(statement: Statement): boolean {
        if (isReturnStatement(statement)) return true;
        if (isBlock(statement)) return statement.statements.some(alwaysReturns);
        if (isIfStatement(statement)) {
          return Boolean(
            statement.elseStatement &&
            alwaysReturns(statement.thenStatement) &&
            alwaysReturns(statement.elseStatement),
          );
        }
        if (isSwitchStatement(statement)) {
          return (
            statement.caseBlock.clauses.some((clause) => !("expression" in clause)) &&
            statement.caseBlock.clauses.every((clause) => clause.statements.some(alwaysReturns))
          );
        }
        return false;
      }

      return {
        complete:
          !hasEmptyReturn &&
          body.statements.some(alwaysReturns) &&
          resolutions.length > 0 &&
          resolutions.every(({ complete }) => complete),
        objects: resolutions.flatMap(({ objects }) => objects),
      };
    }
    if (!isIdentifier(expression) || seen.has(expression.text)) {
      return { complete: false, objects: [] };
    }
    let initializer: Expression | FunctionDeclaration | undefined;
    for (let current: Node | undefined = expression; current; current = current.parent) {
      if (!isBlock(current) && !isSourceFile(current)) continue;
      initializer = bindings.get(current)?.get(expression.text);
      if (initializer) break;
    }
    return initializer
      ? resolveObjectsDetailed(initializer, new Set(seen).add(expression.text))
      : { complete: false, objects: [] };
  }

  function resolveObjects(expression: Expression | FunctionDeclaration) {
    return resolveObjectsDetailed(expression).objects;
  }

  collectBindings(sourceFile);

  type EffectiveProperties = Map<string | Node, Node>;

  function isConfigCombinatorCall(expression: Expression): expression is CallExpression {
    return (
      isCallExpression(expression) &&
      ((isIdentifier(expression.expression) && configCombinators.has(expression.expression.text)) ||
        (isPropertyAccessExpression(expression.expression) &&
          isIdentifier(expression.expression.expression) &&
          configNamespaces.has(expression.expression.expression.text) &&
          expression.expression.name.text === "mergeConfig"))
    );
  }

  function effectiveProperties(
    expression: Expression,
    seen = new Set<ObjectLiteralExpression>(),
  ): EffectiveProperties[] {
    return resolveObjects(expression).flatMap((object) => {
      if (seen.has(object)) return [];
      const nextSeen = new Set(seen).add(object);
      let alternatives: EffectiveProperties[] = [new Map()];
      for (const property of object.properties) {
        if (isSpreadAssignment(property)) {
          const spreads = effectiveProperties(property.expression, nextSeen);
          if (spreads.length > 0) {
            alternatives = alternatives.flatMap((effective) =>
              spreads.map((spread) => {
                const merged = new Map(effective);
                for (const [name, spreadProperty] of spread) {
                  merged.set(name, spreadProperty);
                }
                return merged;
              }),
            );
          } else {
            for (const effective of alternatives) effective.set(property, property);
          }
        } else if (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) {
          const name = propertyName(property.name) ?? property.name;
          for (const effective of alternatives) {
            effective.set(name, property);
          }
        }
      }
      return alternatives;
    });
  }

  function propertyValue(property: Node) {
    if (isPropertyAssignment(property)) return property.initializer;
    if (isShorthandPropertyAssignment(property)) return property.name;
  }

  type ConfigSections = Map<"define" | "public", EffectiveProperties>;

  function mergeProperties(
    earlier: EffectiveProperties | undefined,
    later: EffectiveProperties,
  ): EffectiveProperties {
    const merged = new Map(earlier);
    for (const [name, property] of later) merged.set(name, property);
    return merged;
  }

  function configSectionAlternatives(expression: Expression): ConfigSections[] {
    if (
      isParenthesizedExpression(expression) ||
      isAsExpression(expression) ||
      isSatisfiesExpression(expression) ||
      isTypeAssertionExpression(expression) ||
      isNonNullExpression(expression)
    ) {
      return configSectionAlternatives(expression.expression);
    }
    if (isConditionalExpression(expression)) {
      return [
        ...configSectionAlternatives(expression.whenTrue),
        ...configSectionAlternatives(expression.whenFalse),
      ];
    }
    if (
      isCallExpression(expression) &&
      isPropertyAccessExpression(expression.expression) &&
      isIdentifier(expression.expression.expression) &&
      expression.expression.expression.text === "Promise" &&
      expression.expression.name.text === "resolve" &&
      expression.arguments[0]
    ) {
      return configSectionAlternatives(expression.arguments[0]);
    }
    if (isConfigCombinatorCall(expression)) {
      return expression.arguments.reduce<ConfigSections[]>(
        (configs, argument) => {
          const laterConfigs = configSectionAlternatives(argument) || [];
          const effectiveLaterConfigs = laterConfigs.length > 0 ? laterConfigs : [new Map()];
          return configs.flatMap((config) =>
            effectiveLaterConfigs.map((later) => {
              const merged = new Map(config);
              for (const [section, properties] of later) {
                merged.set(section, mergeProperties(merged.get(section), properties));
              }
              return merged;
            }),
          );
        },
        [new Map()],
      );
    }
    if (isCallExpression(expression) && isIdentifier(expression.expression)) {
      for (let current: Node | undefined = expression; current; current = current.parent) {
        if (!isBlock(current) && !isSourceFile(current)) continue;
        const factory = bindings.get(current)?.get(expression.expression.text);
        if (factory) return configAlternativesFromResolved(factory);
      }
    }
    if (isIdentifier(expression)) {
      for (let current: Node | undefined = expression; current; current = current.parent) {
        if (!isBlock(current) && !isSourceFile(current)) continue;
        const value = bindings.get(current)?.get(expression.text);
        if (value) return configAlternativesFromResolved(value);
      }
    }
    if (isArrowFunction(expression) || isFunctionExpression(expression)) {
      return configAlternativesFromResolved(expression);
    }

    return resolveObjects(expression).flatMap((config) =>
      effectiveProperties(config).flatMap((configProperties) => {
        const envProperty = configProperties.get("env");
        const envValue = envProperty && propertyValue(envProperty);
        if (!envValue) return [];
        return effectiveProperties(envValue).flatMap((envProperties) => {
          let alternatives: ConfigSections[] = [new Map()];
          for (const section of ["define", "public"] as const) {
            const sectionProperty = envProperties.get(section);
            const sectionValue = sectionProperty && propertyValue(sectionProperty);
            if (!sectionValue) continue;
            const sectionAlternatives = effectiveProperties(sectionValue);
            alternatives = alternatives.flatMap((configSections) =>
              sectionAlternatives.map((properties) => {
                const next = new Map(configSections);
                next.set(section, properties);
                return next;
              }),
            );
          }
          return alternatives;
        });
      }),
    );
  }

  function configAlternativesFromResolved(
    expression: Expression | FunctionDeclaration,
  ): ConfigSections[] {
    if (
      isArrowFunction(expression) ||
      isFunctionExpression(expression) ||
      isFunctionDeclaration(expression)
    ) {
      if (!expression.body) return [];
      if (!isBlock(expression.body)) return configSectionAlternatives(expression.body);
      const alternatives: ConfigSections[] = [];
      function collectReturns(node: Node) {
        if (
          node !== expression.body &&
          (isArrowFunction(node) || isFunctionExpression(node) || isFunctionDeclaration(node))
        ) {
          return;
        }
        if (isReturnStatement(node)) {
          if (node.expression) alternatives.push(...configSectionAlternatives(node.expression));
          return;
        }
        forEachChild(node, collectReturns);
      }
      collectReturns(expression.body);
      return alternatives;
    }
    return configSectionAlternatives(expression);
  }

  function markDefineValue(
    expression: Expression,
    seen = new Set<ObjectLiteralExpression>(),
    seenBindings = new Set<string>(),
  ) {
    sections.set(expression, "define");
    if (isIdentifier(expression) && !seenBindings.has(expression.text)) {
      for (let current: Node | undefined = expression; current; current = current.parent) {
        if (!isBlock(current) && !isSourceFile(current)) continue;
        const value = bindings.get(current)?.get(expression.text);
        if (value && !isFunctionDeclaration(value)) {
          markDefineValue(value, seen, new Set(seenBindings).add(expression.text));
          break;
        }
      }
    }
    for (const object of resolveObjects(expression)) {
      if (seen.has(object)) continue;
      const nextSeen = new Set(seen).add(object);
      for (const properties of effectiveProperties(object, seen)) {
        for (const property of properties.values()) {
          sections.set(property, "define");
          const value = propertyValue(property);
          if (value) markDefineValue(value, nextSeen, seenBindings);
        }
      }
    }
  }

  function collectConfig(expression: Expression) {
    for (const configSections of configSectionAlternatives(expression)) {
      for (const [section, properties] of configSections) {
        for (const property of properties.values()) {
          sections.set(property, section);
          const value = propertyValue(property);
          if (section === "define" && value) markDefineValue(value);
        }
      }
    }
  }

  function collectSections(node: Node) {
    if (
      isCallExpression(node) &&
      ((isIdentifier(node.expression) && configBindings.has(node.expression.text)) ||
        (isPropertyAccessExpression(node.expression) &&
          isIdentifier(node.expression.expression) &&
          configNamespaces.has(node.expression.expression.text) &&
          node.expression.name.text === "defineConfig"))
    ) {
      if (node.arguments[0]) collectConfig(node.arguments[0]);
    } else if (isExportAssignment(node)) {
      collectConfig(node.expression);
    }
    forEachChild(node, collectSections);
  }

  collectSections(sourceFile);
  function resolveString(expression: Expression, seen = new Set<string>()): string | undefined {
    if (
      isParenthesizedExpression(expression) ||
      isAsExpression(expression) ||
      isSatisfiesExpression(expression) ||
      isTypeAssertionExpression(expression) ||
      isNonNullExpression(expression)
    ) {
      return resolveString(expression.expression, seen);
    }
    if (isStringLiteralLike(expression)) return expression.text;
    if (!isIdentifier(expression) || seen.has(expression.text)) return undefined;
    let initializer: Expression | FunctionDeclaration | undefined;
    for (let current: Node | undefined = expression; current; current = current.parent) {
      if (!isBlock(current) && !isSourceFile(current)) continue;
      initializer = bindings.get(current)?.get(expression.text);
      if (initializer) break;
    }
    return initializer && !isFunctionDeclaration(initializer)
      ? resolveString(initializer, new Set(seen).add(expression.text))
      : undefined;
  }

  return { resolveObjectsDetailed, resolveString, sections };
}

function declarationSection(
  call: CallExpression,
  sections: ReadonlyMap<Node, "define" | "public">,
) {
  for (let node: Node | undefined = call; node; node = node.parent) {
    const section = sections.get(node);
    if (section) return section;
  }
}

function objectHasBuildMode(
  options: ObjectLiteralExpression,
  resolveObjectsDetailed: (expression: Expression | FunctionDeclaration) => {
    complete: boolean;
    objects: ObjectLiteralExpression[];
  },
  resolveString: (expression: Expression) => string | undefined,
): boolean {
  function effectiveModes(
    object: ObjectLiteralExpression,
    modes: boolean[],
    seen: ReadonlySet<ObjectLiteralExpression>,
  ): boolean[] {
    if (seen.has(object)) return modes.map(() => false);
    const nextSeen = new Set(seen).add(object);
    let alternatives = modes;
    for (const property of object.properties) {
      if (isSpreadAssignment(property)) {
        const spread = resolveObjectsDetailed(property.expression);
        alternatives =
          spread.complete && spread.objects.length > 0
            ? alternatives.flatMap((mode) =>
                spread.objects.flatMap((spreadObject) =>
                  effectiveModes(spreadObject, [mode], nextSeen),
                ),
              )
            : alternatives.map(() => false);
      } else if (isPropertyAssignment(property)) {
        const name = propertyName(property.name);
        if (name === "mode") {
          const isBuildMode = resolveString(property.initializer) === "build";
          alternatives = alternatives.map(() => isBuildMode);
        } else if (isComputedPropertyName(property.name) && name === undefined) {
          alternatives = alternatives.map(() => false);
        }
      } else if (isShorthandPropertyAssignment(property) && property.name.text === "mode") {
        const isBuildMode = resolveString(property.name) === "build";
        alternatives = alternatives.map(() => isBuildMode);
      } else if (
        (isMethodDeclaration(property) ||
          isGetAccessorDeclaration(property) ||
          isSetAccessorDeclaration(property)) &&
        propertyName(property.name) === "mode"
      ) {
        alternatives = alternatives.map(() => false);
      }
    }
    return alternatives;
  }

  return effectiveModes(options, [false], new Set()).every(Boolean);
}

function hasBuildMode(options: {
  complete: boolean;
  objects: readonly ObjectLiteralExpression[];
  resolveObjectsDetailed: (expression: Expression | FunctionDeclaration) => {
    complete: boolean;
    objects: ObjectLiteralExpression[];
  };
  resolveString: (expression: Expression) => string | undefined;
}): boolean {
  return (
    options.complete &&
    options.objects.length > 0 &&
    options.objects.every((object) =>
      objectHasBuildMode(object, options.resolveObjectsDetailed, options.resolveString),
    )
  );
}

function buildEnvCalls(source: string) {
  const codeBlocks = [
    ...source.matchAll(/^[\t ]*```(?:ts|typescript)[^\n]*\n([\s\S]*?)^[\t ]*```$/gm),
  ].map((match) => match[1] || "");

  return codeBlocks.flatMap((code) => {
    const { calls, sourceFile } = envCalls(code);
    const { resolveObjectsDetailed, resolveString, sections } = sectionObjects(sourceFile);
    return calls.flatMap((call) => {
      const section = declarationSection(call, sections);
      const argument = call.arguments[0];
      return section
        ? [
            {
              call,
              options: argument
                ? { ...resolveObjectsDetailed(argument), resolveObjectsDetailed, resolveString }
                : {
                    complete: false,
                    objects: [],
                    resolveObjectsDetailed,
                    resolveString,
                  },
              section,
            },
          ]
        : [];
    });
  });
}

function fixtureHasBuildMode(options: string) {
  const call = buildEnvCalls(`
\`\`\`ts
defineConfig({ env: { public: { value: env(${options}) } } })
\`\`\`
  `)[0];
  return call ? hasBuildMode(call.options) : false;
}

describe("Env documentation", () => {
  it("parses supported declarations and ignores non-code calls", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { env as declareEnv } from "@vite-hub/env/vite"
import * as envApi from "@vite-hub/env/vite"
import { defineConfig } from "vite"
import * as unrelatedApi from "unrelated-env"
import { env as unrelatedEnv } from "unrelated-env"

const public = {
    appName: declareEnv({ source: declareEnv.source("APP_NAME"), mode: "build" }),
    region: declareEnv.variable({ mode: "build" }),
    target: envApi.env({ mode: "build" }),
    stage: envApi.env.variable({ mode: "build" }),
    ignoredNamespace: unrelatedApi.env({ mode: "runtime" }),
    ignored: unrelatedEnv({ mode: "runtime" }),
}
const defineEnv = {
  __TARGET__: declareEnv({ mode: "build" }),
}
defineConfig({ env: { public, define: defineEnv } })
// env({ mode: "runtime" })
const example = "env({ mode: 'runtime' })"
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual([
      "public",
      "public",
      "public",
      "public",
      "define",
    ]);
    expect(calls.every(({ options }) => hasBuildMode(options))).toBe(true);
  });

  it("ignores similarly named Server Env keys", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
defineConfig({
  env: {
    server: {
      public: { token: env({ secret: true }) },
    },
  },
})
\`\`\`
    `);

    expect(calls).toEqual([]);
  });

  it("parses TypeScript fences nested in Markdown containers", () => {
    const calls = buildEnvCalls(`
::tabs
  :::tabs-item{label="Vite"}
    \`\`\`ts [vite.config.ts]
    defineConfig({ env: { public: { appName: env({ mode: "runtime" }) } } })
    \`\`\`
  :::
::
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows configs returned by callbacks", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const publicEnv = { appName: env({ mode: "build" }) }
defineConfig(() => ({ env: { public: publicEnv } }))
defineConfig(function () {
  return { env: { define: { __TARGET__: env({ mode: "build" }) } } }
})
defineConfig(({ mode }) => {
  if (mode === "production") {
    return { env: { public: { apiUrl: env({ mode: "build" }) } } }
  }
  switch (mode) {
    case "test":
      return { env: { define: { __TEST__: env({ mode: "build" }) } } }
    default:
      return { env: { public: { apiUrl: env({ mode: "build" }) } } }
  }
})
defineConfig(({ mode }) =>
  mode === "production"
    ? { env: { public: { apiUrl: env({ mode: "build" }) } } }
    : { env: { define: { __DEV__: env({ mode: "build" }) } } },
)
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual([
      "public",
      "define",
      "public",
      "define",
      "public",
      "public",
      "define",
    ]);
  });

  it("follows configs returned by named function declarations", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
function config() {
  return { env: { public: { appName: env({ mode: "runtime" }) } } }
}
defineConfig(config)
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows invoked named configuration factories", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
function config() {
  return { env: { public: { appName: env({ mode: "runtime" }) } } }
}
defineConfig(config())
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("ignores returns from nested named functions", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
defineConfig(() => {
  function unused() {
    return { env: { public: { ignored: env({ mode: "runtime" }) } } }
  }
  return { env: { public: { appName: env({ mode: "build" }) } } }
})
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(true);
  });

  it("follows objects spread into build-backed sections", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const shared = { apiUrl: env({ mode: "build" }) }
const nested = { ...shared, region: env({ mode: "build" }) }
defineConfig({ env: { public: { ...nested, appName: env({ mode: "build" }) } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public", "public", "public"]);
  });

  it("ignores section entries overwritten after a spread", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const inherited = { appName: env({ mode: "runtime" }) }
const publicEnv = { ...inherited, appName: env({ mode: "build" }) }
defineConfig({ env: { public: publicEnv } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(true);
  });

  it("checks every conditional spread branch", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const runtimeEntries = { appName: env({ mode: "runtime" }) }
const buildEntries = { appName: env({ mode: "build" }) }
defineConfig({ env: { public: { ...(flag ? runtimeEntries : buildEntries) } } })
\`\`\`
    `);

    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([false, true]);
  });

  it("checks known entries after unresolved spreads", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
defineConfig({
  ...getDefaults(),
  env: {
    public: {
      ...getSharedEnv(),
      appName: env({ mode: "runtime" }),
    },
  },
})
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("checks reachable entries inside unresolved spreads", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
function entries(value) {
  return value
}
defineConfig({
  env: {
    public: {
      appName: env({ mode: "build" }),
      ...entries({ token: env({ mode: "runtime" }) }),
    },
  },
})
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public", "public"]);
    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([true, false]);
  });

  it("checks computed section entries", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
defineConfig({ env: { public: { ["appName"]: env({ mode: "runtime" }) } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows objects spread into Env configurations", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const shared = { public: { appName: env({ mode: "runtime" }) } }
defineConfig({ env: { ...shared } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("honors overrides at config and Env boundaries", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const inheritedConfig = {
  env: { public: { ignoredConfig: env({ mode: "runtime" }) } },
}
const inheritedEnv = {
  public: { ignoredEnv: env({ mode: "runtime" }) },
}
defineConfig({
  ...inheritedConfig,
  env: {
    ...inheritedEnv,
    public: { appName: env({ mode: "build" }) },
  },
})
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(true);
  });

  it("follows aliased Vite config helpers", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { defineConfig as viteConfig } from "vite"
viteConfig({ env: { public: { appName: env({ mode: "runtime" }) } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows namespace-imported Vite config helpers", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import * as vite from "vite"
vite.defineConfig({ env: { public: { appName: env({ mode: "runtime" }) } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows inline configs passed through Vite config combinators", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { defineConfig, mergeConfig as combineConfig } from "vite"
defineConfig(combineConfig(base, {
  env: { public: { appName: env({ mode: "runtime" }) } },
}))
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("applies Vite config combinator override semantics", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { defineConfig, mergeConfig } from "vite"
defineConfig(mergeConfig(
  { env: { public: {
    replaced: env({ mode: "runtime" }),
    retained: env({ mode: "build" }),
  } } },
  { env: { public: { replaced: env({ mode: "build" }) } } },
))
defineConfig(mergeConfig(
  { env: { public: { rejected: env({ mode: "build" }) } } },
  { env: { public: { rejected: env({ mode: "runtime" }) } } },
))
\`\`\`
    `);

    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([true, true, false]);
  });

  it("applies Vite config combinator overrides through callbacks and bindings", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { defineConfig, mergeConfig } from "vite"
const combined = mergeConfig(
  { env: { public: { replaced: env({ mode: "runtime" }) } } },
  { env: { public: { replaced: env({ mode: "build" }) } } },
)
defineConfig(() => combined)
\`\`\`
    `);

    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([true]);
  });

  it("resolves configuration objects through lexical bindings", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const publicEnv = { appName: env({ mode: "runtime" }) }
defineConfig({ env: { public: publicEnv } })
function unrelated() {
  const publicEnv = { appName: env({ mode: "build" }) }
  return publicEnv
}
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows directly exported and TypeScript-wrapped configs", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
export default {
  env: { public: { direct: env({ mode: "runtime" }) } },
}
defineConfig({
  env: { public: { satisfies: env({ mode: "runtime" }) } },
} satisfies UserConfig)
defineConfig(({ env: {
  define: { __CAST__: env({ mode: "runtime" }) },
} } as UserConfig)!)
defineConfig(<UserConfig>{
  env: { public: { asserted: env({ mode: "runtime" }) } },
})
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public", "public", "define", "public"]);
    expect(calls.every(({ options }) => !hasBuildMode(options))).toBe(true);
  });

  it("follows referenced nested Define Env registries", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const group = { target: env({ mode: "runtime" }) }
defineConfig({ env: { define: { group } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["define"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("follows Promise-wrapped configs and shorthand Define Env values", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const target = env({ mode: "runtime" })
const group = { target }
defineConfig(Promise.resolve({ env: { define: { group } } }))
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["define"]);
    expect(hasBuildMode(calls[0]!.options)).toBe(false);
  });

  it("requires the last effective top-level mode to be build", () => {
    expect(fixtureHasBuildMode("{ source: env.source('APP_NAME'), mode: 'build' }")).toBe(true);
    expect(fixtureHasBuildMode('<EnvOptions>{ mode: "build" }')).toBe(true);
    expect(fixtureHasBuildMode("{ default: \"mode: 'build'\" }")).toBe(false);
    expect(fixtureHasBuildMode("{ default: 'preview' /* mode: 'build' */ }")).toBe(false);
    expect(fixtureHasBuildMode("{ default: /\\(/ }")).toBe(false);
    expect(fixtureHasBuildMode("{ default: flag && /mode: 'build'/ }")).toBe(false);
    expect(fixtureHasBuildMode("{ default: () => /mode: 'build'/ }")).toBe(false);
    expect(fixtureHasBuildMode("{ default: /mode: 'build'/, mode: 'build' }")).toBe(true);
    expect(fixtureHasBuildMode("{ defaults: { mode: 'build' } }")).toBe(false);
    expect(fixtureHasBuildMode("{ mode: 'build', mode: 'runtime' }")).toBe(false);
    expect(fixtureHasBuildMode("{ mode: 'build', ...defaults }")).toBe(false);
    expect(fixtureHasBuildMode("{ ...defaults, mode: 'build' }")).toBe(true);
    expect(fixtureHasBuildMode("{ mode: 'build', [key]: 'runtime' }")).toBe(false);
    expect(fixtureHasBuildMode("{ [key]: 'runtime', mode: 'build' }")).toBe(true);
    expect(fixtureHasBuildMode("{ mode: 'build', ['default']: 'Acme' }")).toBe(true);
  });

  it("resolves declaration options through lexical bindings and TypeScript wrappers", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const buildOptions = { mode: "build" } as const
const runtimeOptions = { mode: "runtime" } satisfies EnvOptions
defineConfig({
  env: {
    public: {
      valid: env(buildOptions),
      invalid: env(runtimeOptions),
    },
  },
})
\`\`\`
    `);

    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([true, false]);
  });

  it("resolves shorthand mode bindings", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const mode = "build"
defineConfig({ env: { public: { appName: env({ mode }) } } })
\`\`\`
    `);

    expect(hasBuildMode(calls[0]!.options)).toBe(true);
  });

  it("resolves declaration option spreads with last-write semantics", () => {
    expect(fixtureHasBuildMode("{ ...{ mode: 'build' } }")).toBe(true);
    const calls = buildEnvCalls(`
\`\`\`ts
const buildOptions = { mode: "build" }
defineConfig({
  env: {
    public: {
      spread: env({ ...buildOptions }),
      spreadLast: env({ mode: "runtime", ...buildOptions }),
      overrideLast: env({ ...buildOptions, mode: "runtime" }),
      conditional: env({ ...(flag ? buildOptions : { mode: "runtime" }) }),
    },
  },
})
\`\`\`
    `);

    expect(calls.map(({ options }) => hasBuildMode(options))).toEqual([true, true, false, false]);
  });

  it("rejects enumerable mode methods and accessors from option spreads", () => {
    expect(fixtureHasBuildMode("{ mode: 'build', ...{ mode() {} } }")).toBe(false);
    expect(fixtureHasBuildMode("{ mode: 'build', ...{ get mode() { return 'build' } } }")).toBe(
      false,
    );
    expect(fixtureHasBuildMode("{ mode: 'build', ...{ set mode(value) {} } }")).toBe(false);
  });

  it("rejects declaration options with an unresolved conditional branch", () => {
    expect(fixtureHasBuildMode("flag ? { mode: 'build' } : getOptions()")).toBe(false);
  });

  it("rejects declaration option factories with incomplete returns", () => {
    expect(fixtureHasBuildMode("() => { if (flag) return { mode: 'build' } }")).toBe(false);
    expect(fixtureHasBuildMode("() => { if (flag) return { mode: 'build' }; return }")).toBe(false);
  });

  it("marks every documented build-backed Env declaration as build-time", async () => {
    const pages = [
      "content/docs/server-primitives/env.md",
      "content/docs/reference/config-options.md",
    ];
    const calls = (
      await Promise.all(pages.map((page) => readFile(resolve(docsRoot, page), "utf8")))
    ).flatMap(buildEnvCalls);

    expect(calls.filter(({ section }) => section === "public")).toHaveLength(3);
    expect(calls.filter(({ section }) => section === "define")).toHaveLength(1);
    for (const { options } of calls) {
      expect(hasBuildMode(options)).toBe(true);
    }
  });
});
