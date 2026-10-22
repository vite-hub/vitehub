import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { build } from "esbuild"
import { expect, it } from "vitest"

it("keeps build dependencies out of the published application entry", async () => {
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, "../dist/index.js")],
    format: "esm",
    metafile: true,
    packages: "external",
    platform: "node",
    write: false,
  })
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(entry => entry.path))

  expect(imports).not.toContain("esbuild")
  expect(imports).not.toContain("vite")
  expect(imports).not.toContain("node:fs")
  expect(imports).not.toContain("node:fs/promises")
  expect(imports).not.toContain("node:path")
})

it("keeps build dependencies out of the runtime Process entry", async () => {
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, "../dist/runtime/process.js")],
    format: "esm",
    metafile: true,
    packages: "external",
    platform: "node",
    write: false,
  })
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(entry => entry.path))

  expect(imports).not.toContain("esbuild")
  expect(imports).not.toContain("vite")
  expect(imports).not.toContain("node:fs")
  expect(imports).not.toContain("node:fs/promises")
})

it("loads every published JavaScript entry", async () => {
  // A source file that only fails to parse after bundling (for example a duplicate
  // top-level function declaration) still builds, so import each packed target.
  const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    exports: Record<string, string | { import?: string }>
  }
  const targets = Object.values(packageJson.exports)
    .map(target => typeof target === "string" ? target : target.import)
    .filter((target): target is string => typeof target === "string" && target.endsWith(".js"))

  expect(targets).toContain("./dist/runtime.js")
  for (const target of targets) {
    await expect(import(pathToFileURL(resolve(import.meta.dirname, "..", target)).href), target).resolves.toBeDefined()
  }
})
