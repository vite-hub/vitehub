import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteralLike,
  type CallExpression,
  type Node,
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
  return calls;
}

function declarationSection(call: CallExpression): "define" | "public" | undefined {
  for (let node: Node | undefined = call.parent; node; node = node.parent) {
    if (!isPropertyAssignment(node)) continue;
    const name = propertyName(node.name);
    if (name === "define" || name === "public") return name;
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

  return codeBlocks.flatMap((code) =>
    envCalls(code).flatMap((call) => {
      const section = declarationSection(call);
      return section ? [{ call, section }] : [];
    }),
  );
}

function fixtureHasBuildMode(options: string) {
  const call = buildEnvCalls(`
\`\`\`ts
const config = { public: { value: env(${options}) } }
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
import * as unrelatedApi from "unrelated-env"
import { env as unrelatedEnv } from "unrelated-env"

const config = {
  public: {
    appName: declareEnv({ source: declareEnv.source("APP_NAME"), mode: "build" }),
    region: declareEnv.variable({ mode: "build" }),
    target: envApi.env({ mode: "build" }),
    stage: envApi.env.variable({ mode: "build" }),
    ignoredNamespace: unrelatedApi.env({ mode: "runtime" }),
    ignored: unrelatedEnv({ mode: "runtime" }),
  },
}
// env({ mode: "runtime" })
const example = "env({ mode: 'runtime' })"
\`\`\`
    `);

    expect(calls.map(({ section }) => section)).toEqual(["public", "public", "public", "public"]);
    expect(calls.every(({ call }) => hasBuildMode(call))).toBe(true);
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
