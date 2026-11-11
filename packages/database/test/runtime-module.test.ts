import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeHostedDatabaseRuntimeModules } from "../src/internal/vite-build.ts"
import { createDatabaseBindingLookup } from "../src/runtime/agent.ts"
import { createUseDatabase } from "../src/runtime/use-database.ts"

it("keeps prototype-named databases addressable in hosted modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-db-runtime-proto-"))
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src/__proto__.database.ts"), 'export default defineDatabase({ name: "__proto__", schema: {} })\n')
    const config = resolveDBViteConfig(undefined, root)!
    const output = join(root, ".vitehub/database")
    await writeHostedDatabaseRuntimeModules(output, config)

    const defaultsCode = await readFile(join(output, "definition-defaults.mjs"), "utf8")
    const defaults = new Function(`${defaultsCode.replace(/^export default /, "return ")}\n`)() as {
      cloudflareProjections: Record<string, unknown>
    }
    expect(Object.hasOwn(defaults.cloudflareProjections, "__proto__")).toBe(true)

    for (const provider of ["cloudflare", "vercel"]) {
      const binding = { prepare: () => ({}), batch: async () => [] }
      const createHostedDrizzleDb = vi.fn(() => ({ marker: "database", $client: binding }))
      const code = await readFile(join(output, `${provider}-runtime.mjs`), "utf8")
      const evaluable = code.replace(/^(?:import .+|export .+ from .+)$/gm, "").replace(/^export /gm, "") + "\nreturn { databases, useDatabase, useDatabaseBinding }"
      const runtime = new Function("definition_0", "schema_0", "relations_0", "createHostedDrizzleDb", "createAgentDatabase", "createDatabaseBindingLookup", "defaultDatabaseNotConfiguredError", "resolveRuntimeCloudflareConfig", "createUseDatabase", evaluable)(
        { name: "__proto__", drizzle: {}, schema: {} },
        { marker: "schema" },
        { marker: "relations" },
        createHostedDrizzleDb,
        () => ({}),
        createDatabaseBindingLookup,
        () => new Error("missing"),
        (value: unknown) => value,
        createUseDatabase,
      ) as { databases: Record<string, unknown>, useDatabase: (name?: string) => unknown, useDatabaseBinding: (name: string) => unknown }

      expect(createHostedDrizzleDb).not.toHaveBeenCalled()
      expect(runtime.useDatabaseBinding("__proto__")).toBe(binding)
      expect(Object.hasOwn(runtime.databases, "__proto__")).toBe(true)
      expect(runtime.useDatabase("__proto__")).toEqual({ db: { marker: "database", $client: binding }, relations: { marker: "relations" }, schema: { marker: "schema" } })
      expect(runtime.useDatabase()).toBe(runtime.useDatabase("__proto__"))
      expect(() => runtime.useDatabase("default")).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND", why: "The database \"default\" is not configured. Database Definitions: \"__proto__\"." }))
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
