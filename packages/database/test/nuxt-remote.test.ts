import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

describe("Nuxt remote Database development", () => {
  it.each(["remote", "http"])("uses D1 HTTP for direct and registry queries with %s", async (mode) => {
    const root = await mkdtemp(join(packageRoot, ".vitest-nuxt-remote-"))
    const definition = join(root, "server/databases/config.ts")
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
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
        hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { buildDir: join(root, ".nuxt"), dev: true, rootDir: root, vite: {} },
      })
      const config = { alias: {} as Record<string, string> }
      for (const hook of hooks) await hook(config)
      const entry = join(root, "query.mjs")
      await writeFile(entry, [
        'import definition from "./server/databases/config.ts"',
        'import { useDatabase } from "@vite-hub/database/drizzle"',
        'process.env.CLOUDFLARE_ACCOUNT_ID = "account-id"',
        'process.env.CLOUDFLARE_API_TOKEN = "api-token"',
        'globalThis.__env__ = { DB: { prepare() { throw new Error("Unexpected local binding") } } }',
        'const requests = []',
        'globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({ result: [{ results: { rows: [["real note"]] }, success: true }], success: true }) }',
        'const { db, schema } = useDatabase("default")',
        'const direct = await definition.select().from(definition.schema.notes)',
        'const registry = await db.select().from(schema.notes)',
        'console.log(JSON.stringify({ direct, registry, requests }))',
      ].join("\n"))
      const output = join(root, "query.output.mjs")
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
        registry: [{ title: "real note" }],
        requests: Array.from({ length: 2 }, () => "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/real-database-id/raw"),
      })
      expect(stderr).toContain('Database "default" is remote')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
