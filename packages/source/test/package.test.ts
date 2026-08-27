import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/source package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/source", [
      ".",
      "./content",
      "./content/client",
      "./file",
      "./github",
      "./glob",
      "./markdown",
      "./mcp",
    ])
  })

  it("keeps CommonJS dependency discovery out of the glob bundle", async () => {
    const output = await readFile(new URL("../dist/glob.js", import.meta.url), "utf8")

    expect(output).not.toContain("createRequire")
    expect(output).not.toMatch(/from ["'](?:node:)?module["']/)
    expect(output).not.toMatch(/require\(["']picomatch["']\)/)
  })
})
