import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { hubDb } from "../src/nuxt.ts"
import { migrateOnStart } from "../src/runtime/migrate-on-start.ts"
import { hubDb as hubDbVite } from "../src/vite.ts"

import type { DatabaseNuxtIntegrationOptions, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

const init = { sql: "CREATE TABLE `users` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE `legacy` (`id` integer);\n", tag: "0000_init", when: 1_700_000_000_000 }
const seed = { sql: "INSERT INTO `users` (`id`, `name`) VALUES (7, 'Ada');", tag: "0001_seed", when: 1_700_000_001_000 }
const dropLegacy = { sql: "DROP TABLE `legacy`;", tag: "0002_drop_legacy", when: 1_700_000_002_000 }

async function createProject() {
  const root = await mkdtemp(join(packageRoot, ".vitest-migrate-on-start-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
  await mkdir(join(root, "server/databases"), { recursive: true })
  await writeFile(join(root, "server/databases/config.ts"), [
    'import { defineDatabase } from "@vite-hub/database"',
    'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"',
    'export default defineDatabase({ schema: { users: sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) } })',
  ].join("\n"))
  return root
}

async function writeMigrations(root: string, migrations: Array<{ sql: string, tag: string, when: number }>) {
  const dir = join(root, "server/databases/migrations")
  await mkdir(join(dir, "meta"), { recursive: true })
  await writeFile(join(dir, "meta/_journal.json"), JSON.stringify({
    dialect: "sqlite",
    entries: migrations.map((migration, idx) => ({ breakpoints: true, idx, tag: migration.tag, version: "6", when: migration.when })),
    version: "7",
  }))
  for (const migration of migrations) {
    await writeFile(join(dir, `${migration.tag}.sql`), migration.sql)
  }
  return dir
}

/** Runs the Nuxt module for a production Node build and bundles a server whose entry imports Nitro's plugins first. */
async function buildNodeServer(root: string, options: DatabaseNuxtIntegrationOptions) {
  const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  await hubDb(options)(undefined, {
    hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
      if (event === "nitro:config") hooks.push(callback)
    },
    options: { buildDir: join(root, ".nuxt"), dev: false, nitro: { preset: "node-server" }, rootDir: root, vite: {} },
  })
  const config: Record<string, unknown> & { alias: Record<string, string>, plugins?: string[] } = { alias: {} }
  for (const hook of hooks) await hook(config)
  const entry = join(root, "server.mjs")
  await writeFile(entry, [
    ...(config.plugins ?? []).map(plugin => `import ${JSON.stringify(plugin)}`),
    'import { useDatabase } from "@vite-hub/database/drizzle"',
    'const { db, schema } = useDatabase("default")',
    "console.log(JSON.stringify(await db.select().from(schema.users)))",
  ].join("\n"))
  const output = join(root, "server.output.mjs")
  await build({
    alias: { ...config.alias, "@vite-hub/database": join(packageRoot, "src/index.ts") },
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    outfile: output,
    packages: "external",
    platform: "node",
    plugins: [{
      name: "node-file-imports",
      setup(plugin) {
        plugin.onResolve({ filter: /^file:\/\// }, args => plugin.resolve(fileURLToPath(args.path), { kind: args.kind, resolveDir: args.resolveDir }))
      },
    }],
  })
  return { config, start: () => execFileAsync(process.execPath, [output], { cwd: root }) }
}

async function readLedger(url: string) {
  const client = createClient({ url })
  try {
    return (await client.execute("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")).rows.map(row => Number(row[1]))
  }
  finally {
    client.close()
  }
}

describe("database.migrateOnStart", () => {
  it("applies pending migrations once before a Node server handles requests, in Drizzle Kit's ledger", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const migrationsDir = await writeMigrations(root, [init, seed])
    const url = `file:${join(root, "data/app.sqlite")}`
    const server = await buildNodeServer(root, { connection: { url }, migrateOnStart: true })
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])

    const first = await server.start()
    expect(first.stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 0000_init.',
      '[vitehub] Database "default": applied 0001_seed.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    // The second start finds nothing pending, so the seed row is not inserted twice.
    expect((await server.start()).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(url)).toEqual([init.when, seed.when])

    // `vitehub db migrate` and Drizzle's own migrator read the same ledger and find nothing to apply.
    const database = { connection: { url }, dialect: "sqlite", drizzle: {}, generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } satisfies ResolvedDrizzleDatabaseConfig
    const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending).toEqual([])
    const client = createClient({ url })
    try {
      await migrate(drizzle({ client }), { migrationsFolder: migrationsDir })
      expect((await client.execute("SELECT count(*) FROM users")).rows[0]?.[0]).toBe(1)
    }
    finally {
      client.close()
    }
  })

  it("refuses to start with a pending migration that loses data, unless allowDataLoss is set", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const url = `file:${join(root, "data/app.sqlite")}`
    await writeMigrations(root, [init, seed])
    await (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()

    await writeMigrations(root, [init, seed, dropLegacy])
    const refused = (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()
    await expect(refused).rejects.toThrow(/DATABASE_MIGRATION_DATA_LOSS|lose data/)
    expect(await readLedger(url)).toEqual([init.when, seed.when])

    const allowed = await buildNodeServer(root, { connection: { url }, migrateOnStart: { allowDataLoss: true } })
    expect((await allowed.start()).stdout).toContain('[vitehub] Database "default": applied 0002_drop_legacy.')
    expect(await readLedger(url)).toEqual([init.when, seed.when, dropLegacy.when])
  })

  it("adds the plugin only to production Node builds of the Vite integration", async () => {
    const root = await createProject()
    await writeMigrations(root, [init])
    const setup = async (options: { dev?: boolean, preset: string }) => {
      const plugin = hubDbVite({ migrateOnStart: true })
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [], root })
      const nitroOptions: Parameters<typeof plugin.nitro.setup>[0]["options"] = { ...options, output: { serverDir: join(root, ".output/server") } }
      plugin.nitro.setup({ hooks: { hook: () => {} }, options: nitroOptions })
      return nitroOptions.plugins
    }
    expect(await setup({ preset: "node-server" })).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await setup({ dev: true, preset: "node-server" })).toBeUndefined()
    await expect(setup({ preset: "cloudflare-module" })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
  })

  it("refuses a database that is not a local SQLite file", async () => {
    const client = { execute: async () => ({ rows: [] }), migrate: async () => [], protocol: "https" }
    await expect(migrateOnStart([{ db: { $client: client }, migrations: [], name: "remote" }])).rejects.toMatchObject({
      code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
      why: expect.stringContaining("libSQL over https"),
    })
  })
})
