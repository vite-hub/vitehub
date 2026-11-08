import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

describe("Nuxt remote Database development", () => {
  it.each([
    { customRegistry: false, mode: "remote" },
    { customRegistry: false, mode: "http" },
    { customRegistry: true, mode: "remote" },
    { customRegistry: true, mode: "http" },
  ])("uses D1 HTTP with $mode and custom registry $customRegistry", async ({ customRegistry, mode }) => {
    const root = await mkdtemp(join(packageRoot, ".vitest-nuxt-remote-"))
    const definition = join(root, "server/databases/config.ts")
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    const watchHooks: Array<(event: string, path: string) => Promise<void> | void> = []
    try {
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
      await writeFile(definition, [
        'import { defineDatabase } from "@vite-hub/database"',
        'import { sqliteTable, text } from "drizzle-orm/sqlite-core"',
        'const notes = sqliteTable("notes", { title: text("title") })',
        `export default defineDatabase({ ${mode === "remote" ? "remote: true," : ""} schema: { notes } })`,
      ].join("\n"))
      await hubDb({
        binding: "DB",
        cloudflare: mode === "http" ? { http: true } : undefined,
        databaseId: "real-database-id",
        databaseName: "notes",
        driver: "d1",
      })(undefined, {
        hook: (event: string, callback: unknown) => {
          // SAFETY: The nitro:config hook receives Nitro's configuration object from Nuxt.
          if (event === "nitro:config") hooks.push(callback as (config: Record<string, unknown>) => Promise<void> | void)
          // SAFETY: The builder:watch hook receives the event and changed path from Nuxt.
          if (event === "builder:watch") watchHooks.push(callback as (event: string, path: string) => Promise<void> | void)
        },
        options: { buildDir: join(root, ".nuxt"), dev: true, rootDir: root, vite: {} },
      })
      const config = { alias: {} as Record<string, string> }
      if (customRegistry) config.alias["@vite-hub/database/drizzle"] = "#custom-database"
      for (const hook of hooks) await hook(config)
      const entry = join(root, "query.mjs")
      await writeFile(entry, [
        'import definition from "./server/databases/config.ts"',
        ...customRegistry ? [] : ['import { useDatabase } from "@vite-hub/database/drizzle"'],
        'process.env.CLOUDFLARE_ACCOUNT_ID = "account-id"',
        'process.env.CLOUDFLARE_API_TOKEN = "api-token"',
        'globalThis.__env__ = { DB: { prepare() { throw new Error("Unexpected local binding") } } }',
        'const requests = []',
        'globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ result: [{ results: { rows: [["real note"]] }, success: true }], success: true }) }',
        ...customRegistry ? [] : ['const { db, schema } = useDatabase("default")'],
        'const direct = await definition.select().from(definition.schema.notes)',
        customRegistry ? 'const registry = undefined' : 'const registry = await db.select().from(schema.notes)',
        'console.log(JSON.stringify({ direct, registry, requests }))',
      ].join("\n"))
      const output = join(root, "query.output.mjs")
      const query = async (databaseId: string) => {
        await build({
          alias: {
            ...config.alias,
            "@vite-hub/database": join(packageRoot, "src/index.ts"),
            "#vitehub/database/definition-runtime": join(packageRoot, "src/runtime/definition-local.ts"),
          },
          bundle: true,
          entryPoints: [entry],
          format: "esm",
          outfile: output,
          packages: "external",
          platform: "node",
          plugins: [{
            name: "node-file-imports",
            setup(plugin) {
              plugin.onResolve({ filter: /^file:\/\// }, args => plugin.resolve(fileURLToPath(args.path), {
                kind: args.kind,
                resolveDir: args.resolveDir,
              }))
            },
          }],
        })
        const { stdout, stderr } = await execFileAsync(process.execPath, [output], { cwd: root })
        expect(JSON.parse(stdout)).toEqual({
          direct: [{ title: "real note" }],
          ...customRegistry ? {} : { registry: [{ title: "real note" }] },
          requests: Array.from({ length: customRegistry ? 1 : 2 }, () => `https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/${databaseId}/raw`),
        })
        expect(stderr).toContain('Database "default" is remote')
      }
      await query("real-database-id")
      if (customRegistry) {
        await writeFile(definition, (await readFile(definition, "utf8")).replace("schema: { notes }", 'cloudflare: { binding: "UPDATED_DB", databaseId: "updated-database-id", databaseName: "updated-notes" }, schema: { notes }'))
        for (const hook of watchHooks) await hook("change", definition)
        expect(config.alias["@vite-hub/database/drizzle"]).toBe("#custom-database")
        await query("updated-database-id")
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
