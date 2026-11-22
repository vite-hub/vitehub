import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")

const allowedSpecifiers: Readonly<Record<string, string>> = {
  "@vite-hub/database/runtime/registry": "An alias key. The Database owner points it at the app's generated Database runtime.",
}

const typeDeclarations: Readonly<Record<string, string>> = {
  "packages/auth/src/nuxt.ts": "`PageMeta.auth` type in the Nuxt app types.",
  "packages/docs/src/nuxt.ts": "Docs template declarations. The app extends `@vite-hub/docs`.",
  "packages/sandbox/src/task/type-template.ts": "Sandbox Task registry declarations.",
}

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
}, 60_000)
