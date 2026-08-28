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
  isExportAssignment,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNonNullExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteralLike,
  isSatisfiesExpression,
  isVariableDeclaration,
  type CallExpression,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
  ScriptKind,
  ScriptTarget,
} from "typescript";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const envDeclarationModules = new Set(["@vite-hub/env", "@vite-hub/env/vite", "vite-hub/env"]);

function propertyName(node: Node) {
  return isIdentifier(node) || isStringLiteralLike(node) ? node.text : undefined;
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
  const bindings = new Map<string, Expression>();
  const configBindings = new Set(["defineConfig"]);
  const sections = new Map<Node, "define" | "public">();

  function collectBindings(node: Node) {
    if (
      isImportDeclaration(node) &&
      isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "vite" &&
      node.importClause?.namedBindings &&
      isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "defineConfig") {
          configBindings.add(element.name.text);
        }
      }
    }
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    forEachChild(node, collectBindings);
  }

  function resolveObjects(
    expression: Expression,
    seen = new Set<string>(),
  ): ObjectLiteralExpression[] {
    if (
      isParenthesizedExpression(expression) ||
      isAsExpression(expression) ||
      isSatisfiesExpression(expression) ||
      isNonNullExpression(expression)
    ) {
      return resolveObjects(expression.expression, seen);
    }
    if (isConditionalExpression(expression)) {
      return [
        ...resolveObjects(expression.whenTrue, new Set(seen)),
        ...resolveObjects(expression.whenFalse, new Set(seen)),
      ];
    }
    if (isObjectLiteralExpression(expression)) return [expression];
    if (isArrowFunction(expression) || isFunctionExpression(expression)) {
      if (!isBlock(expression.body)) return resolveObjects(expression.body, seen);

      const body = expression.body;
      const returned: Expression[] = [];
      function collectReturns(node: Node) {
        if (node !== body && (isArrowFunction(node) || isFunctionExpression(node))) {
          return;
        }
        if (isReturnStatement(node)) {
          if (node.expression) returned.push(node.expression);
          return;
        }
        forEachChild(node, collectReturns);
      }
      collectReturns(body);
      return returned.flatMap((value) => resolveObjects(value, new Set(seen)));
    }
    if (!isIdentifier(expression) || seen.has(expression.text)) return [];
    const initializer = bindings.get(expression.text);
    return initializer ? resolveObjects(initializer, new Set(seen).add(expression.text)) : [];
  }

  function resolveSpreadObjects(expression: Expression) {
    const objects: ObjectLiteralExpression[] = [];
    const seen = new Set<ObjectLiteralExpression>();

    function collect(value: Expression) {
      for (const object of resolveObjects(value)) {
        if (seen.has(object)) continue;
        seen.add(object);
        objects.push(object);
        for (const property of object.properties) {
          if (isSpreadAssignment(property)) collect(property.expression);
        }
      }
    }

    collect(expression);
    return objects;
  }

  function propertyValue(object: ObjectLiteralExpression, name: string) {
    for (const property of object.properties) {
      if (isPropertyAssignment(property) && propertyName(property.name) === name) {
        return property.initializer;
      }
      if (isShorthandPropertyAssignment(property) && property.name.text === name) {
        return property.name;
      }
    }
  }

  collectBindings(sourceFile);
  function collectConfig(expression: Expression) {
    for (const config of resolveSpreadObjects(expression)) {
      const env = propertyValue(config, "env");
      const envConfigs = env ? resolveSpreadObjects(env) : [];
      for (const envConfig of envConfigs) {
        for (const section of ["define", "public"] as const) {
          const value = propertyValue(envConfig, section);
          const objects = value ? resolveSpreadObjects(value) : [];
          for (const object of objects) sections.set(object, section);
        }
      }
    }
  }

  function collectSections(node: Node) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      configBindings.has(node.expression.text)
    ) {
      if (node.arguments[0]) collectConfig(node.arguments[0]);
    } else if (isExportAssignment(node)) {
      collectConfig(node.expression);
    }
    forEachChild(node, collectSections);
  }

  collectSections(sourceFile);
  return sections;
}

function declarationSection(
  call: CallExpression,
  sections: ReadonlyMap<Node, "define" | "public">,
) {
  for (let node: Node | undefined = call.parent; node; node = node.parent) {
    const section = sections.get(node);
    if (section) return section;
  }
}

function hasBuildMode(call: CallExpression): boolean {
  const options = call.arguments[0];
  if (!options || !isObjectLiteralExpression(options)) return false;

  let isBuildMode = false;
  for (const property of options.properties) {
    if (isSpreadAssignment(property)) {
      isBuildMode = false;
    } else if (isPropertyAssignment(property) && propertyName(property.name) === "mode") {
      isBuildMode =
        isStringLiteralLike(property.initializer) && property.initializer.text === "build";
    }
  }
  return isBuildMode;
}

function buildEnvCalls(source: string) {
  const codeBlocks = [...source.matchAll(/^```(?:ts|typescript)[^\n]*\n([\s\S]*?)^```$/gm)].map(
    (match) => match[1] || "",
  );

  return codeBlocks.flatMap((code) => {
    const { calls, sourceFile } = envCalls(code);
    const sections = sectionObjects(sourceFile);
    return calls.flatMap((call) => {
      const section = declarationSection(call, sections);
      return section ? [{ call, section }] : [];
    });
  });
}

function fixtureHasBuildMode(options: string) {
  const call = buildEnvCalls(`
\`\`\`ts
defineConfig({ env: { public: { value: env(${options}) } } })
\`\`\`
  `)[0]?.call;
  return call ? hasBuildMode(call) : false;
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
    expect(calls.every(({ call }) => hasBuildMode(call))).toBe(true);
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

  it("follows objects spread into Env configurations", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
const shared = { public: { appName: env({ mode: "runtime" }) } }
defineConfig({ env: { ...shared } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.call)).toBe(false);
  });

  it("follows aliased Vite config helpers", () => {
    const calls = buildEnvCalls(`
\`\`\`ts
import { defineConfig as viteConfig } from "vite"
viteConfig({ env: { public: { appName: env({ mode: "runtime" }) } } })
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public"]);
    expect(hasBuildMode(calls[0]!.call)).toBe(false);
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
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public", "public", "define"]);
    expect(calls.every(({ call }) => !hasBuildMode(call))).toBe(true);
  });

  it("requires the last effective top-level mode to be build", () => {
    expect(fixtureHasBuildMode("{ source: env.source('APP_NAME'), mode: 'build' }")).toBe(true);
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
    for (const { call } of calls) {
      expect(hasBuildMode(call)).toBe(true);
    }
  });
});
