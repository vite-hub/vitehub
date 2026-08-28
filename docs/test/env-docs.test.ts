import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteralLike,
  type CallExpression,
  type Node,
  type ObjectLiteralExpression,
  ScriptKind,
  ScriptTarget,
} from "typescript";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "..");
const canonicalPages = [
  "content/docs/server-primitives/env.md",
  "content/docs/reference/config-options.md",
] as const;

function typescriptExamples(markdown: string) {
  return [...markdown.matchAll(/^```(?:ts|typescript)(?: \[[^\]]+\])?\n([\s\S]*?)^```$/gm)].map(
    ([, source]) => source!,
  );
}

function propertyName(node: Node) {
  if (isIdentifier(node) || isStringLiteralLike(node)) return node.text;
}

function declarationSection(call: CallExpression) {
  for (let node: Node | undefined = call.parent; node; node = node.parent) {
    if (!isPropertyAssignment(node)) continue;
    const name = propertyName(node.name);
    if (name === "public" || name === "define" || name === "server") return name;
  }
}

function directEnvDeclarations(source: string) {
  const sourceFile = createSourceFile(
    "documented-env.ts",
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  const calls: CallExpression[] = [];

  function visit(node: Node) {
    if (
      isCallExpression(node) &&
      (isIdentifier(node.expression) || isPropertyAccessExpression(node.expression))
    ) {
      const expression = node.expression;
      const isDirectEnv = isIdentifier(expression) && expression.text === "env";
      const isEnvVariable =
        isPropertyAccessExpression(expression) &&
        isIdentifier(expression.expression) &&
        expression.expression.text === "env" &&
        expression.name.text === "variable";
      if (isDirectEnv || isEnvVariable) calls.push(node);
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
  return calls;
}

function optionsHaveBuildMode(options: ObjectLiteralExpression) {
  let mode: string | undefined;
  for (const property of options.properties) {
    if (!isPropertyAssignment(property) || propertyName(property.name) !== "mode") continue;
    mode = isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
  }
  return mode === "build";
}

async function canonicalBuildDeclarations() {
  const declarations: CallExpression[] = [];
  for (const page of canonicalPages) {
    const markdown = await readFile(resolve(docsRoot, page), "utf8");
    for (const source of typescriptExamples(markdown)) {
      declarations.push(
        ...directEnvDeclarations(source).filter((call) => {
          const section = declarationSection(call);
          return section === "public" || section === "define";
        }),
      );
    }
  }
  return declarations;
}

describe("canonical Env documentation", () => {
  it("keeps every Public Env and Define Env declaration in build mode", async () => {
    const declarations = await canonicalBuildDeclarations();

    expect(declarations).toHaveLength(4);
    for (const declaration of declarations) {
      const options = declaration.arguments[0];
      expect(isObjectLiteralExpression(options) && optionsHaveBuildMode(options)).toBe(true);
    }
  });

  it("recognizes only direct canonical build-backed declarations", () => {
    const source = `
      defineConfig({ env: {
        public: {
          valid: env({ mode: "build" }),
          invalid: env.variable({ mode: "runtime" }),
        },
        server: { token: env({ mode: "runtime" }) },
      } })
    `;
    const declarations = directEnvDeclarations(source).filter((call) => {
      const section = declarationSection(call);
      return section === "public" || section === "define";
    });

    expect(declarations).toHaveLength(2);
    expect(
      declarations.map((declaration) => {
        const options = declaration.arguments[0];
        return isObjectLiteralExpression(options) && optionsHaveBuildMode(options);
      }),
    ).toEqual([true, false]);
  });
});
