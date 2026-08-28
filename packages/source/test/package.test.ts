import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createProgram, getParsedCommandLineOfConfigFile, sys } from "typescript"
import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/source package contract", () => {
  it("includes generated Collection types through its TypeScript config", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-tsconfig-"))
    const generatedTypes = join(root, ".vitehub/types/source/collections.d.ts")
    const generatedTypesEntry = join(root, ".vitehub/types/source/index.d.ts")
    const applicationEntry = join(root, "src/index.ts")
    const configEntry = resolve(import.meta.dirname, "../tsconfig.vite.d.ts")
    const emptyEntry = resolve(import.meta.dirname, "../types/source/index.d.ts")
    try {
      await mkdir(dirname(applicationEntry), { recursive: true })
      await Promise.all([
        writeFile(applicationEntry, "export {}\n"),
        writeFile(join(root, "tsconfig.json"), JSON.stringify({
          extends: [resolve(import.meta.dirname, "../tsconfig.vite.json")],
          include: ["src"],
          compilerOptions: {
            paths: {
              "#application/*": ["./src/*"],
            },
          },
        })),
      ])

      const parse = () => getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, {
        ...sys,
        onUnRecoverableConfigFileDiagnostic: diagnostic => {
          throw new TypeError(String(diagnostic.messageText))
        },
      })
      const sourceFiles = (parsed: NonNullable<ReturnType<typeof parse>>) => new Set(
        createProgram({ options: parsed.options, rootNames: parsed.fileNames })
          .getSourceFiles()
          .map(sourceFile => sourceFile.fileName),
      )
      const clean = parse()
      if (!clean) throw new TypeError("Expected clean Source TypeScript config.")
      expect(clean?.errors).toEqual([])
      expect(new Set(clean?.fileNames)).toEqual(new Set([applicationEntry, configEntry]))
      expect(sourceFiles(clean)).toContain(emptyEntry)

      await mkdir(dirname(generatedTypes), { recursive: true })
      await Promise.all([
        writeFile(generatedTypes, "interface ViteHubCollectionMap { meals: unknown }\n"),
        writeFile(generatedTypesEntry, '/// <reference path="./collections.d.ts" />\n'),
      ])
      const generated = parse()
      if (!generated) throw new TypeError("Expected generated Source TypeScript config.")
      expect(generated?.errors).toEqual([])
      expect(new Set(generated?.fileNames)).toEqual(new Set([applicationEntry, configEntry]))
      expect(sourceFiles(generated)).toContain(generatedTypes)
      expect(sourceFiles(generated)).not.toContain(emptyEntry)

      await Promise.all([rm(generatedTypes), rm(generatedTypesEntry)])
      const removed = parse()
      if (!removed) throw new TypeError("Expected cleaned Source TypeScript config.")
      expect(removed?.errors).toEqual([])
      expect(new Set(removed?.fileNames)).toEqual(new Set([applicationEntry, configEntry]))
      expect(sourceFiles(removed)).toContain(emptyEntry)
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
      "./vite",
    ])
    const tsconfig = fileURLToPath(import.meta.resolve("@vite-hub/source/tsconfig"))
    expect(tsconfig).toBe(resolve(import.meta.dirname, "../tsconfig.vite.json"))
    await expect(readFile(tsconfig, "utf8")).resolves.toContain(".vitehub/types")
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
