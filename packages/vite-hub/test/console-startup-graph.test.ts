import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const internalSource = resolve(packageRoot, "../internal/src")
const packageExports: Record<string, { import?: string }> = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports
// A static `import` or `export ... from` that is not type-only. Dynamic `import()` calls do not match.
const staticImport = /^(?:import|export)\s+(?!type\s)(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/gm

function staticSpecifiers(code: string): string[] {
  return [...code.matchAll(staticImport)].map(match => match[1]!)
}

/** The source file of a `vite-hub/*` or `@vite-hub/internal/*` specifier. ViteHub bundles `@vite-hub/internal`. */
function sourceFile(specifier: string, importer?: string): string | undefined {
  if (specifier.startsWith(".") && importer) return resolve(dirname(importer), specifier)
  if (specifier.startsWith("@vite-hub/internal/")) return join(internalSource, `${specifier.slice("@vite-hub/internal/".length)}.ts`)
  const target = specifier.startsWith("vite-hub/") ? packageExports[`./${specifier.slice("vite-hub/".length)}`]?.import : undefined
  return target ? join(packageRoot, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")) : undefined
}

/** Every source file that the generated code loads with static imports, and the packages that those files import. */
function startupGraph(code: string): { files: Set<string>, packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (specifier: string, importer?: string): void => {
    const file = sourceFile(specifier, importer)
    if (!file) {
      packages.add(specifier)
      return
    }
    if (files.has(file) || !existsSync(file)) return
    files.add(file)
    for (const next of staticSpecifiers(readFileSync(file, "utf8"))) visit(next, file)
  }
  for (const specifier of staticSpecifiers(code)) visit(specifier)
  return { files, packages }
}

describe("Console server startup graph", () => {
  it("loads the operations, usage index, and journal stores on the first Console request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-startup-"))
    try {
      const file = join(root, "plugin.mjs")
      await writeConsoleNitroPlugin(
        file,
        root,
        ["agents", "databases", "env", "kv", "mcp-client"],
        [],
        { agents: [], content: {}, operations: [{ export: "kvOperations", module: "@vite-hub/kv/console", plugin: "@vite-hub/kv/vite" }] },
        [],
        undefined,
        undefined,
        false,
        undefined,
        () => true,
        { d1Binding: "DB" },
        false,
        undefined,
        { mode: "open" },
        { blob: "vite-hub/_internal/blob", console: "vite-hub/console/server", db: "vite-hub/database/drizzle", kv: "vite-hub/_internal/kv" },
      )
      const generated = await readFile(file, "utf8")
      expect(staticSpecifiers(generated).sort()).toEqual(["vite-hub/_internal/agent/runtime/workflow", "vite-hub/console/sections", "vite-hub/console/server"])
      for (const module of ["vite-hub/console/operations", "vite-hub/_internal/kv/console", "vite-hub/console/mcp-client", "vite-hub/database/drizzle", "vite-hub/_internal/kv"]) {
        expect(generated).toContain(`import(${JSON.stringify(module)})`)
      }

      const { files, packages } = startupGraph(generated)
      const loaded = [...files].map(file => relative(packageRoot, file))
      expect(loaded).toContain("src/console/runtime/server/access-policy.ts")
      expect(loaded).toContain("src/console/runtime/server/invocations.ts")
      for (const lazy of ["operation-contributions.ts", "operations.ts", "usage-index.ts", "invocations-database.ts", "mcp.ts", "mcp-client-operations.ts", "rpc.ts"]) {
        expect(loaded).not.toContain(`src/console/runtime/server/${lazy}`)
      }
      for (const lazy of ["@vite-hub/agent/invocations/d1", "@libsql/client", "drizzle-orm"]) expect(packages).not.toContain(lazy)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
