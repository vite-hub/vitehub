import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const internalSource = resolve(packageRoot, "../internal/src")
const agentSource = resolve(packageRoot, "../agent/src")
const packageExports: Record<string, { import?: string }> = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports
// A static `import` or `export ... from` that is not type-only. Dynamic `import()` calls do not match.
const staticImport = /^(?:import|export)\s+(?!type\s)(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/gm

function staticSpecifiers(code: string): string[] {
  return [...code.matchAll(staticImport)].map(match => match[1]!)
}

/**
 * The source file of a `vite-hub/*` or `@vite-hub/internal/*` specifier, or of a module that generated code imports by
 * path. ViteHub bundles `@vite-hub/internal`.
 */
function sourceFile(specifier: string, importer?: string): string | undefined {
  if (specifier.startsWith(".") && importer) return resolve(dirname(importer), specifier)
  if (specifier.startsWith(join(packageRoot, "dist/"))) return join(packageRoot, "src", relative(join(packageRoot, "dist"), specifier).replace(/\.js$/, ".ts"))
  if (specifier.startsWith(join(packageRoot, "src/"))) return specifier
  if (specifier === "@vite-hub/agent/internal/default-invocations-core") return join(agentSource, "internal/default-invocations-core.ts")
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
      await writeConsoleNitroPlugin({
        file,
        projectRoot: root,
        sections: ["agents", "databases", "env", "kv", "mcp-client"],
        catalog: { agents: [], content: {}, operations: [{ export: "kvOperations", module: "/kv/dist/console.js", plugin: "@vite-hub/kv/vite" }] },
        blobStores: [],
        access: { mode: "open" },
        runtimeCapabilityImports: { blob: "vite-hub/blob", console: "vite-hub/console/server", db: "@vite-hub/database/runtime/registry", kv: "vite-hub/kv" },
      })
      const generated = await readFile(file, "utf8")
      expect(staticSpecifiers(generated).sort()).toEqual([generatedModules.consoleSetup])
      for (const module of ["vite-hub/console/server", generatedModules.consoleOperations, "/kv/dist/console.js", "vite-hub/console/mcp-client", "@vite-hub/database/runtime/registry", "vite-hub/kv"]) {
        expect(generated).toContain(`import(${JSON.stringify(module)})`)
      }

      const { files, packages } = startupGraph(generated)
      expect(files).not.toContain(join(agentSource, "internal/default-invocations-core.ts"))
      expect(files).not.toContain(join(agentSource, "invocations/default-core.ts"))
      const loaded = [...files].map(file => relative(packageRoot, file))
      expect(loaded).toContain("src/console/runtime/server/access-policy.ts")
      // Agent Definitions and the Console's Agent install load with the Console runtime. `vite-hub/agent` resolves the
      // app-wide journal of an Agent that runs before the first Console request.
      expect(files).not.toContain(join(agentSource, "invocations/default.ts"))
      expect(files).not.toContain(join(agentSource, "internal/default-invocations.ts"))
      for (const lazy of ["agents.ts", "invocations.ts", "operation-contributions.ts", "operations.ts", "usage-index.ts", "invocations-database.ts", "mcp.ts", "mcp-client-operations.ts", "rpc.ts"]) {
        expect(loaded).not.toContain(`src/console/runtime/server/${lazy}`)
      }
      for (const lazy of ["d1.ts", "sqlite.ts"]) expect(files).not.toContain(join(agentSource, "invocations", lazy))
      for (const lazy of ["@vite-hub/agent/invocations", "@libsql/client", "drizzle-orm"]) expect(packages).not.toContain(lazy)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("loads the Console access and sign-in pages on the first Console request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-startup-"))
    try {
      const file = join(root, "plugin.mjs")
      await writeConsoleNitroPlugin({
        file,
        projectRoot: root,
        sections: ["kv"],
        catalog: { agents: [], content: {}, operations: [{ export: "kvOperations", module: "/kv/dist/console.js", plugin: "@vite-hub/kv/vite" }] },
        blobStores: [],
        access: { mode: "local" },
        runtimeCapabilityImports: { blob: "vite-hub/blob", console: "vite-hub/console/server", db: "@vite-hub/database/runtime/registry", kv: "vite-hub/kv" },
      })
      const generated = await readFile(file, "utf8")
      expect(staticSpecifiers(generated)).toEqual([generatedModules.consoleSetup])
      for (const removed of ["installConsoleClient(", "installConsoleBuild(", "installConsolePageTool("]) {
        expect(generated).not.toContain(removed)
      }
      const loaded = [...startupGraph(generated).files].map(file => relative(packageRoot, file))
      expect(loaded).toContain("src/console/runtime/server/access-policy.ts")
      for (const removed of ["client-assets.ts", "page-tool.ts"]) {
        expect(loaded).not.toContain(`src/console/runtime/server/${removed}`)
      }
      for (const lazy of ["src/console/auth-pages.ts", "src/console/runtime/server/access.ts", "src/console/runtime/server/sections.ts"]) {
        expect(loaded).not.toContain(lazy)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
