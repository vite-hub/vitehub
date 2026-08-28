import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { getParsedCommandLineOfConfigFile, sys } from "typescript"
import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/source package contract", () => {
  it("includes generated Collection types through its TypeScript config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-tsconfig-"))
    const generatedTypes = join(root, ".vitehub/types/source/collections.d.ts")
    try {
      await mkdir(dirname(generatedTypes), { recursive: true })
      await Promise.all([
        writeFile(generatedTypes, "interface ViteHubCollectionMap { meals: unknown }\n"),
        writeFile(join(root, "tsconfig.json"), JSON.stringify({
          extends: [resolve(import.meta.dirname, "../tsconfig.vite.json")],
        })),
      ])

      const parsed = getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
        ...sys,
        onUnRecoverableConfigFileDiagnostic: diagnostic => {
          throw new TypeError(String(diagnostic.messageText))
        },
      })

      expect(parsed?.fileNames).toEqual([generatedTypes])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

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
    const entry = join(import.meta.dirname, "..", "dist", "glob.js")
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
  })
})
