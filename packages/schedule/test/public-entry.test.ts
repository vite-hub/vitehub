import { resolve } from "node:path"

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
