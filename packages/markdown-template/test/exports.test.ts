import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

it.each([
  [ts.ModuleResolutionKind.NodeNext, ts.ModuleKind.NodeNext, "index"],
  [ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext, "portable"],
] as const)("resolves declarations for module resolution %s", (moduleResolution, module, entry) => {
  const root = resolve(import.meta.dirname, "..")
  const declarations = new Set(["index", "portable", "file"].map(name => resolve(root, `dist/${name}.d.ts`)))
  const canonical = (path: string) => path.replace(/^.*\/node_modules\/@vite-hub\/markdown-template(?=\/)/, root)
  // Model published declaration files without requiring a local package build.
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: path => declarations.has(canonical(path)) || ts.sys.fileExists(path),
    directoryExists: path => canonical(path) === resolve(root, "dist") || ts.sys.directoryExists(path),
    realpath: path => declarations.has(canonical(path)) ? canonical(path) : (ts.sys.realpath?.(path) ?? path),
  }
  for (const importer of [resolve(root, "test/consumer.ts"), resolve(root, "../vite-hub/src/markdown-template.ts")]) {
    const result = ts.resolveModuleName("@vite-hub/markdown-template", importer, {
      moduleResolution,
      module,
    }, host, undefined, undefined, ts.ModuleKind.ESNext)
    expect(result.resolvedModule?.resolvedFileName).toBe(resolve(root, `dist/${entry}.d.ts`))
    const fileResult = ts.resolveModuleName("@vite-hub/markdown-template/file", importer, {
      moduleResolution,
      module,
    }, host, undefined, undefined, ts.ModuleKind.ESNext)
    expect(fileResult.resolvedModule?.resolvedFileName).toBe(resolve(root, "dist/file.d.ts"))
  }
  expect(readFileSync(resolve(root, "../vite-hub/src/markdown-template.ts"), "utf8").trim())
    .toBe('export * from "@vite-hub/markdown-template"')
})

it("forwards the filesystem subpath through vite-hub", () => {
  const root = resolve(import.meta.dirname, "../../vite-hub")
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  expect(manifest.exports["./markdown-template/file"]).toBe("./dist/markdown-template/file.js")
  expect(readFileSync(resolve(root, "src/markdown-template/file.ts"), "utf8").trim())
    .toBe('export * from "@vite-hub/markdown-template/file"')
})
