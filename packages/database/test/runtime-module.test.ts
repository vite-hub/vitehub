import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeHostedDatabaseRuntimeModules } from "../src/internal/vite-build.ts"

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
      const code = await readFile(join(output, `${provider}-runtime.mjs`), "utf8")
      const evaluable = code.replace(/^import .+$/gm, "").replace(/^export /gm, "") + "\nreturn { databases, useDatabase }"
      const runtime = new Function("definition_0", "schema_0", "createHostedDrizzleDb", "createAgentDatabase", "defaultDatabaseNotConfiguredError", "resolveRuntimeCloudflareConfig", evaluable)(
        { name: "__proto__", drizzle: {}, schema: {} },
        { marker: "schema" },
        () => ({ marker: "database" }),
        () => ({}),
        () => new Error("missing"),
        (value: unknown) => value,
      ) as { databases: Record<string, unknown>, useDatabase: (name: string) => unknown }

      expect(Object.hasOwn(runtime.databases, "__proto__")).toBe(true)
      expect(runtime.useDatabase("__proto__")).toEqual({ db: { marker: "database" }, schema: { marker: "schema" } })
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
