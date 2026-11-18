import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

/**
 * Code that ViteHub writes into an app, such as `.vitehub/nitro/database/middleware.ts`, must not import an
 * `@vite-hub/*` package by name. The import resolves from the app root, and an app that does not list that package
 * cannot resolve it with strict pnpm: the build fails, and the app typecheck fails on the generated file. Write the
 * absolute path of the module (`resolveRuntimeModule()`, `ownModule()`, `import.meta.resolve()`), or a `vite-hub/*`
 * import, which every app lists.
 */

const repoRoot = resolve(import.meta.dirname, "..")

/** Specifiers that stay bare, with the reason. */
const allowedSpecifiers: Readonly<Record<string, string>> = {
  "@vite-hub/database/runtime/registry": "An alias key. The Database owner points it at the app's generated Database runtime.",
}

/** Generated type declarations. The app installs the owner package to turn the feature on, so the name resolves. */
const typeDeclarations: Readonly<Record<string, string>> = {
  "packages/auth/src/nuxt.ts": "`PageMeta.auth` type in the Nuxt app types.",
  "packages/docs/src/nuxt.ts": "Docs template declarations. The app extends `@vite-hub/docs`.",
  "packages/sandbox/src/task/type-template.ts": "Sandbox Task registry declarations.",
}

// Generated modules quote their specifiers with `"` or `'`. Error text names packages in backticks, which never matches.
const generatedImport = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@vite-hub\/[^"']+)["']/g

function findGeneratedImports(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const [, specifier] of node.text.matchAll(generatedImport)) {
        if (specifier && !allowedSpecifiers[specifier]) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${specifier}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it("writes no bare @vite-hub/* import into generated code", () => {
  const sources = execFileSync("git", ["ls-files", "--", "packages/*/src/*"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(file => /^packages\/[^/]+\/src\/.+\.m?ts$/.test(file) && !/\.(?:test|test-d|d)\.m?ts$/.test(file) && !typeDeclarations[file])
  const found = sources.flatMap(file => findGeneratedImports(file, readFileSync(join(repoRoot, file), "utf8")))
  expect(found).toEqual([])
})
