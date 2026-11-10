import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/source package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/source", [
      ".",
      "./drizzle",
      "./mcp",
      "./vite",
    ])
  })

  it("keeps CommonJS dependency discovery and Node built-ins out of the root's static imports", async () => {
    // A Worker that imports the root and never calls github() must not load the Node built-ins that github() uses.
    const entry = join(import.meta.dirname, "..", "dist", "index.js")
    const pending = [entry]
    const visited = new Set<string>()
    let output = ""

    while (pending.length > 0) {
      const file = pending.pop()
      if (!file) continue
      if (visited.has(file)) continue

      visited.add(file)
      const code = await readFile(file, "utf8")
      output += code

      for (const match of code.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
        pending.push(resolve(dirname(file), match[1]))
      }
    }

    const runtimeOutput = output
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
    expect(runtimeOutput).not.toContain("createRequire")
    expect(runtimeOutput).not.toMatch(/from ["'](?:node:)?module["']/)
    expect(runtimeOutput).not.toMatch(/require\(["']picomatch["']\)/)
    expect(runtimeOutput).not.toMatch(/from ["']node:(?:buffer|crypto|os|zlib)["']/)
  })
})
