import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteralLike,
  type CallExpression,
  type Node,
  type ObjectLiteralExpression,
  ScriptKind,
  ScriptTarget,
} from "typescript";
import { describe, expect, it } from "vitest";

import { frameworkView } from "../modules/tutorials/build";

const docsRoot = resolve(import.meta.dirname, "..");
const canonicalPages = [
  "content/docs/env/index.md",
  "content/docs/env/get-started.md",
  "content/docs/env/configure.md",
  "content/docs/env/server-api.md",
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
    if (name !== "public" && name !== "define" && name !== "server") continue;

    const sections = node.parent;
    const envProperty = sections.parent;
    if (
      isObjectLiteralExpression(sections) &&
      ((isPropertyAssignment(envProperty) &&
        propertyName(envProperty.name) === "env" &&
        envProperty.initializer === sections) ||
        (isCallExpression(envProperty) &&
          isIdentifier(envProperty.expression) &&
          envProperty.expression.text === "hubEnv" &&
          envProperty.arguments[0] === sections))
    ) {
      return name;
    }
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
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === "env") {
      calls.push(node);
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
    const markdown = frameworkView(await readFile(resolve(docsRoot, page), "utf8"), "Vite");
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

    // The standalone hero code tree adds one Vite declaration to the canonical examples.
    expect(declarations).toHaveLength(6);
    for (const declaration of declarations) {
      const options = declaration.arguments[0];
      expect(isObjectLiteralExpression(options) && optionsHaveBuildMode(options)).toBe(true);
    }
  });

  it("recognizes only direct canonical build-backed declarations", () => {
    const source = `
      hubEnv({
        public: {
          valid: env({ mode: "build" }),
          invalid: env({ mode: "runtime" }),
          server: env({ mode: "runtime" }),
        },
        server: { token: env({ mode: "runtime" }) },
      })
    `;
    const declarations = directEnvDeclarations(source).filter((call) => {
      const section = declarationSection(call);
      return section === "public" || section === "define";
    });

    expect(declarations).toHaveLength(3);
    expect(
      declarations.map((declaration) => {
        const options = declaration.arguments[0];
        return isObjectLiteralExpression(options) && optionsHaveBuildMode(options);
      }),
    ).toEqual([true, false, false]);
  });
});
