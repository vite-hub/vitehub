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

import { resolveMigrateOnStart, selectMigrateOnStartDatabases } from "../src/internal/migrate-on-start.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { findDataLoss } from "../src/internal/migration-sql.ts"
import { hubDb } from "../src/nuxt.ts"
import { migrateOnStart, migratePostgres, postgresMigrationLock } from "../src/runtime/migrate-on-start.ts"
import { hubDb as hubDbVite } from "../src/vite.ts"

import type { PostgresMigrationSql } from "../src/runtime/migrate-on-start.ts"
import type { DatabaseNuxtIntegrationOptions, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

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
async function buildNodeServer(root: string, options: DatabaseNuxtIntegrationOptions, plugins: unknown[] = []) {
  const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  await hubDb(options)(undefined, {
    hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
      if (event === "nitro:config") hooks.push(callback)
    },
    options: { buildDir: join(root, ".nuxt"), dev: false, nitro: { preset: "node-server" }, rootDir: root, vite: { plugins } },
  })
  const config: Record<string, unknown> & { alias: Record<string, string>, plugins?: string[] } = { alias: {} }
  for (const hook of hooks) await hook(config)
  await runNitroModules(config)
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

/** Runs the Nitro modules that the hooks added, like Nitro does after it resolves the preset. */
async function runNitroModules(config: Record<string, unknown> & { plugins?: string[] }, preset = "node-server") {
  const options: { plugins?: string[], preset: string } = { plugins: config.plugins, preset }
  for (const module of Array.isArray(config.modules) ? config.modules : []) {
    if (typeof module === "function") await module({ hooks: { hook: () => {} }, options })
  }
  config.plugins = options.plugins
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

  it("migrates the implicit default Database with contributed tables before serving requests", { timeout: 60_000 }, async () => {
    const root = await createProject()
    await rm(join(root, "server/databases/config.ts"))
    const tables = join(root, "tables.mjs")
    await writeFile(tables, [
      'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"',
      'export const usersSchema = { users: sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) }',
    ].join("\n"))
    await writeMigrations(root, [init, seed])
    const url = `file:${join(root, "data/app.sqlite")}`
    const server = await buildNodeServer(root, { connection: { url }, migrateOnStart: true }, [{
      name: "users-owner",
      vitehub: { databases: [{ definition: { export: "usersSchema", module: tables }, name: "users" }] },
    }])
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect((await server.start()).stdout.trim().split("\n").at(-1)).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect((await server.start()).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(url)).toEqual([init.when, seed.when])
  })

  it("does not replay migrations when Definitions share a local SQLite file", async () => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const first = createClient({ url })
    const second = createClient({ url })
    const migrations = [init, seed].map(migration => ({
      dataLoss: [], hash: migration.tag, name: migration.tag, statements: migration.sql.split("--> statement-breakpoint"), when: migration.when,
    }))
    const extra = { dataLoss: [], hash: "extra", name: "0002_extra", statements: ["INSERT INTO users (id, name) VALUES (8, 'Grace')"], when: dropLegacy.when }
    const databases = [
      { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations, name: "default" },
      { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [...migrations, extra], name: "shared" },
    ]
    const applied: string[] = []
    try {
      await migrateOnStart(databases, { log: message => applied.push(message) })
      expect(applied).toEqual([
        '[vitehub] Database "default": applied 0000_init.',
        '[vitehub] Database "default": applied 0001_seed.',
        '[vitehub] Database "shared": applied 0002_extra.',
      ])
      expect((await second.execute("SELECT id, name FROM users ORDER BY id")).rows.map(row => [row[0], row[1]])).toEqual([[7, "Ada"], [8, "Grace"]])
      expect(await readLedger(url)).toEqual([init.when, seed.when, extra.when])
      await migrateOnStart(databases, { log: message => applied.push(message) })
      expect(applied).toHaveLength(3)
      expect(await readLedger(url)).toEqual([init.when, seed.when, extra.when])
    }
    finally {
      first.close()
      second.close()
    }
  })

  it.each([false, true])("orders interleaved migrations of a shared file (reverse Definitions: %s)", async (reverse) => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const first = createClient({ url })
    const second = createClient({ url: new URL(url).href })
    const migration = (entry: typeof init) => ({
      dataLoss: [], hash: entry.tag, name: entry.tag, statements: entry.sql.split("--> statement-breakpoint"), when: entry.when,
    })
    const late = {
      sql: "INSERT INTO users (id, name) SELECT id + 1, 'Grace' FROM users WHERE id = 7",
      tag: "0002_late", when: dropLegacy.when,
    }
    const databases = [
      { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [migration(init), migration(late)], name: "first" },
      { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [migration(init), migration(seed)], name: "second" },
    ]
    if (reverse) databases.reverse()
    const applied: string[] = []
    try {
      await migrateOnStart(databases, { log: message => applied.push(message) })
      expect((await second.execute("SELECT id, name FROM users ORDER BY id")).rows.map(row => [row[0], row[1]])).toEqual([[7, "Ada"], [8, "Grace"]])
      expect(await readLedger(url)).toEqual([init.when, seed.when, late.when])
      expect(applied).toEqual([
        `[vitehub] Database "${reverse ? "second" : "first"}": applied 0000_init.`,
        '[vitehub] Database "second": applied 0001_seed.',
        '[vitehub] Database "first": applied 0002_late.',
      ])
      await migrateOnStart(databases, { log: message => applied.push(message) })
      expect(applied).toHaveLength(3)
      expect(await readLedger(url)).toEqual([init.when, seed.when, late.when])
    }
    finally {
      first.close()
      second.close()
    }
  })

  it.each([seed.when, dropLegacy.when])("refuses an unapplied shared-file migration at or below the ledger (%s)", async (when) => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const first = createClient({ url })
    const second = createClient({ url })
    const migration = (name: string, timestamp: number, sql: string) => ({ dataLoss: [], hash: name, name, statements: [sql], when: timestamp })
    const history = [migration(init.tag, init.when, "CREATE TABLE users (id integer)"), migration("late", dropLegacy.when, "INSERT INTO users VALUES (1)")]
    try {
      await migrateOnStart([{ db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: history, name: "first" }], { log: () => {} })
      const applied: string[] = []
      await expect(migrateOnStart([
        { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [...history, migration("future", dropLegacy.when + 1, "INSERT INTO users VALUES (2)")], name: "first" },
        { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [migration("divergent", when, "CREATE TABLE missing_history (id integer)")], name: "second" },
      ], { allowDataLoss: true, log: message => applied.push(message) })).rejects.toMatchObject({
        code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
        why: expect.stringContaining("divergent"),
      })
      expect(applied).toEqual([])
      expect(await readLedger(url)).toEqual([init.when, dropLegacy.when])
      expect((await first.execute("SELECT id FROM users")).rows.map(row => row[0])).toEqual([1])
      expect((await first.execute("SELECT name FROM sqlite_master WHERE name = 'missing_history'")).rows).toEqual([])
    }
    finally {
      first.close()
      second.close()
    }
  })

  it("rolls back every Definition sharing a file when a migration fails", async () => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const first = createClient({ url })
    const second = createClient({ url })
    try {
      await expect(migrateOnStart([
        {
          db: drizzle({ client: first }), dialect: "sqlite" as const, name: "first",
          migrations: [{ dataLoss: [], hash: init.tag, name: init.tag, statements: init.sql.split("--> statement-breakpoint"), when: init.when }],
        },
        {
          db: drizzle({ client: second }), dialect: "sqlite" as const, name: "second",
          migrations: [{ dataLoss: [], hash: "bad", name: "bad", statements: ["INSERT INTO missing_table VALUES (1)"], when: seed.when }],
        },
      ], { log: () => {} })).rejects.toThrow(/missing_table/)
      expect((await first.execute("SELECT name FROM sqlite_master WHERE name IN ('users', 'legacy', '__drizzle_migrations')")).rows).toEqual([])
    }
    finally {
      first.close()
      second.close()
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

  it("applies a drop of a table that the same start creates, without allowDataLoss", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const migrationsDir = await writeMigrations(root, [init, seed, dropLegacy])
    const url = `file:${join(root, "data/app.sqlite")}`
    const started = await (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()
    expect(started.stdout).toContain('[vitehub] Database "default": applied 0002_drop_legacy.')
    expect(await readLedger(url)).toEqual([init.when, seed.when, dropLegacy.when])

    // `vitehub db migrate --dry-run` reads the same run on a new file and finds no data loss either.
    const database = { connection: { url: `file:${join(root, "data/new.sqlite")}` }, dialect: "sqlite", drizzle: {}, generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } satisfies ResolvedDrizzleDatabaseConfig
    const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => [migration.name, migration.dataLoss])).toEqual([[init.tag, []], [seed.tag, []], [dropLegacy.tag, []]])
  })

  it("refuses to drop a table that a pending rebuild filled with older rows", async () => {
    const root = await createProject()
    const url = `file:${join(root, "app.sqlite")}`
    const client = createClient({ url })
    const migration = (tag: string, when: number, statements: string[]) => ({ dataLoss: findDataLoss(statements, new Map([["legacy", ["id"]]])), hash: tag, name: tag, statements, when })
    const rebuildLegacy = migration("0001_rebuild_legacy", seed.when, [
      "CREATE TABLE `__new_legacy` (`id` integer PRIMARY KEY);",
      "INSERT INTO `__new_legacy`(\"id\") SELECT \"id\" FROM `legacy`;",
      "DROP TABLE `legacy`;",
      "ALTER TABLE `__new_legacy` RENAME TO `legacy`;",
    ])
    const migrations = [migration(init.tag, init.when, init.sql.split("--> statement-breakpoint")), rebuildLegacy, migration(dropLegacy.tag, dropLegacy.when, [dropLegacy.sql])]
    try {
      await migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations: migrations.slice(0, 1), name: "default" }], { log: () => {} })
      await expect(migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations, name: "default" }], { log: () => {} })).rejects.toMatchObject({
        code: "DATABASE_MIGRATION_DATA_LOSS",
        message: expect.stringContaining("0002_drop_legacy: drops table \"legacy\""),
      })
      expect(await readLedger(url)).toEqual([init.when])
    }
    finally {
      client.close()
    }
  })

  it("adds the plugin only to production Node builds of the Vite integration", async () => {
    const root = await createProject()
    await writeMigrations(root, [init])
    const setup = async (options: { dev?: boolean, preset?: string }) => {
      const plugin = hubDbVite({ migrateOnStart: true })
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [], root })
      const nitroOptions: Parameters<typeof plugin.nitro.setup>[0]["options"] = { ...options, output: { serverDir: join(root, ".output/server") } }
      plugin.nitro.setup({ hooks: { hook: () => {} }, options: nitroOptions })
      return nitroOptions.plugins
    }
    expect(await setup({ preset: "node-server" })).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await setup({})).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await setup({ dev: true, preset: "node-server" })).toBeUndefined()
    await expect(setup({ preset: "cloudflare-module" })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
    for (const preset of ["bun", "static"]) {
      await expect(setup({ preset })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
    }
  })

  it.each(["bun", "static"])("rejects the explicit Nuxt preset %s", async (preset) => {
    const root = await createProject()
    await writeMigrations(root, [init])
    for (const source of ["nuxt", "nitro"]) {
      const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
      await hubDb({ migrateOnStart: true })(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { dev: false, nitro: { preset: source === "nuxt" ? preset : "node-server" }, rootDir: root },
      })
      for (const hook of hooks) {
        await expect(hook(source === "nitro" ? { preset } : {})).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" })
      }
    }
  })

  it("checks every database before it changes the first one", async () => {
    const applied: string[] = []
    const client = (name: string) => ({ execute: async () => ({ rows: [] }), migrate: async () => applied.push(name), protocol: "file" })
    const migration = (dataLoss: Array<{ reason: string, statement: string }>) => ({ dataLoss, hash: "hash", name: "0000_init", statements: ["SELECT 1"], when: 1 })
    await expect(migrateOnStart([
      { db: { $client: client("default") }, dialect: "sqlite" as const, migrations: [migration([])], name: "default" },
      { db: { $client: client("orders") }, dialect: "sqlite" as const, migrations: [migration([{ reason: "drops table \"orders\"", statement: "DROP TABLE orders;" }])], name: "orders" },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
    expect(applied).toEqual([])
  })

  it("refuses a database that is not a local SQLite file", async () => {
    const client = { execute: async () => ({ rows: [] }), migrate: async () => [], protocol: "https" }
    await expect(migrateOnStart([{ db: { $client: client }, dialect: "sqlite" as const, migrations: [], name: "remote" }])).rejects.toMatchObject({
      code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
      why: expect.stringContaining("libSQL over https"),
    })
  })
})

describe("migrate on start defaults", () => {
  const config = {
    databaseNames: ["default", "analytics", "edge"],
    databases: {
      analytics: { dialect: "postgresql" },
      default: { dialect: "sqlite" },
      edge: { dialect: "postgresql" },
    },
  } as unknown as ResolvedDBViteConfig

  it("migrates the Postgres databases of a Node build when migrateOnStart is unset", () => {
    const settings = resolveMigrateOnStart({})!
    expect(settings).toEqual({ allowDataLoss: false, explicit: false })
    expect(selectMigrateOnStartDatabases(config, settings, "node")).toEqual(["analytics", "edge"])
    // An unknown host is not Node.
    expect(selectMigrateOnStartDatabases(config, settings, undefined)).toEqual([])
    for (const host of ["cloudflare", "vercel", "bun"]) expect(selectMigrateOnStartDatabases(config, settings, host)).toEqual([])
  })

  it("migrates every database with true, and nothing with false", () => {
    expect(selectMigrateOnStartDatabases(config, resolveMigrateOnStart({ migrateOnStart: true })!, "node")).toEqual(["default", "analytics", "edge"])
    expect(() => selectMigrateOnStartDatabases(config, resolveMigrateOnStart({ migrateOnStart: true })!, "cloudflare")).toThrow(expect.objectContaining({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED" }))
    expect(resolveMigrateOnStart({ migrateOnStart: { allowDataLoss: true } })).toEqual({ allowDataLoss: true, explicit: true })
    expect(resolveMigrateOnStart({ migrateOnStart: false })).toBeUndefined()
    expect(resolveMigrateOnStart(false)).toBeUndefined()
  })

  it("adds the plugin for Postgres when migrateOnStart is unset, and only when it has migrations", async () => {
    const root = await createProject()
    await writeFile(join(root, "server/databases/config.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    expect((await buildNodeServer(root, {})).config.plugins).toBeUndefined()
    await writeMigrations(root, [init])
    expect((await buildNodeServer(root, {})).config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
  })

  it("lets Nitro's resolved preset decide for a Nuxt build without a preset", async () => {
    const root = await createProject()
    await writeFile(join(root, "server/databases/config.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    await writeMigrations(root, [init])
    const configFor = async (preset: string) => {
      const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
      await hubDb({})(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { buildDir: join(root, ".nuxt"), dev: false, nitro: {}, rootDir: root },
      })
      const config: Record<string, unknown> & { plugins?: string[] } = {}
      for (const hook of hooks) await hook(config)
      await runNitroModules(config, preset)
      return config.plugins
    }
    expect(await configFor("node-server")).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await configFor("vercel")).toBeUndefined()
  })

  it("adds the plugin to a Vite build only when the Nitro preset is Node", async () => {
    const root = await createProject()
    await writeFile(join(root, "server/databases/config.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    await writeMigrations(root, [init])
    const setup = async (options: { preset?: string }) => {
      const plugin = hubDbVite({})
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [], root })
      const nitroOptions: Parameters<typeof plugin.nitro.setup>[0]["options"] = { ...options, output: { serverDir: join(root, ".output/server") } }
      plugin.nitro.setup({ hooks: { hook: () => {} }, options: nitroOptions })
      return nitroOptions.plugins
    }
    expect(await setup({ preset: "node-server" })).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await setup({})).toBeUndefined()
    expect(await setup({ preset: "cloudflare-module" })).toBeUndefined()
  })

  it("adds no plugin for SQLite when migrateOnStart is unset", async () => {
    const root = await createProject()
    await writeMigrations(root, [init])
    const server = await buildNodeServer(root, { connection: { url: `file:${join(root, "data/app.sqlite")}` } })
    expect(server.config.plugins).toBeUndefined()
  })
})

describe("migratePostgres", () => {
  const migration = (name: string, when: number, statements: string[]) => ({ dataLoss: [], hash: `hash-${name}`, name, statements, when })
  const ledgerTable = "\"drizzle\".\"__drizzle_migrations\""

  /** A postgres.js client that records each query and answers the lock, identity, and ledger reads. */
  function fakeClient({ database = "app", fail, ledger = [], locked = true }: { database?: string, fail?: string, ledger?: Array<[number, string]>, locked?: boolean }) {
    const queries: Array<[string, unknown[] | undefined]> = []
    const sql: PostgresMigrationSql = {
      unsafe: async (query, parameters) => {
        queries.push([query, parameters])
        if (query === fail) throw new Error("relation \"missing_table\" does not exist")
        if (query.startsWith("select pg_try_advisory_xact_lock")) return [{ locked }]
        if (query.startsWith("select current_database()")) return [{ address: "10.0.0.1", database, port: 5432, started: "2026-11-09" }]
        if (query.startsWith("select hash, created_at")) return ledger.map(([when, hash]) => ({ created_at: String(when), hash }))
        return []
      },
    }
    return { client: { ...sql, begin: async <T>(run: (tx: PostgresMigrationSql) => Promise<T>) => await run(sql) }, queries }
  }

  it("takes the lock before it reads Drizzle's ledger, and applies only the migrations after the newest ledger row", async () => {
    const { client, queries } = fakeClient({ ledger: [[1, "hash-0000_init"]] })
    const log: string[] = []
    const applied = await migratePostgres([{ client, database: { migrations: [migration("0000_init", 1, ["CREATE TABLE a (id int)"]), migration("0001_next", 2, ["CREATE TABLE b (id int)"])], name: "default" } }], { log: message => log.push(message) })
    expect(applied).toEqual(["0001_next"])
    const lock: [string, unknown[]] = ["select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]]
    // One transaction holds the lock from the ledger read to the commit.
    expect(queries).toEqual([
      lock,
      ["set local client_min_messages = warning", undefined],
      ["CREATE SCHEMA IF NOT EXISTS \"drizzle\"", undefined],
      [`CREATE TABLE IF NOT EXISTS ${ledgerTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`, undefined],
      [`select hash, created_at from ${ledgerTable}`, undefined],
      ["CREATE TABLE b (id int)", undefined],
      [`insert into ${ledgerTable} ("hash", "created_at") values ($1, $2)`, ["hash-0001_next", 2]],
    ])
    expect(log).toEqual(['[vitehub] Database "default": applied 0001_next.'])
  })

  it("says that it waits when another process holds the lock", async () => {
    const { client, queries } = fakeClient({ locked: false })
    const log: string[] = []
    await migratePostgres([{ client, database: { migrations: [], name: "default" } }], { log: message => log.push(message) })
    expect(queries[1]).toEqual(["select pg_advisory_xact_lock(hashtext($1))", [postgresMigrationLock]])
    expect(log[0]).toBe('[vitehub] Database "default": another process is applying migrations. Waiting for it to finish.')
  })

  it("names the migration that failed", async () => {
    const { client } = fakeClient({ fail: "INSERT INTO missing_table VALUES (1)" })
    const log: string[] = []
    await expect(migratePostgres([{ client, database: { migrations: [migration("0000_init", 1, ["CREATE TABLE a (id int)"]), migration("0001_broken", 2, ["INSERT INTO missing_table VALUES (1)"])], name: "default" } }], { log: message => log.push(message) }))
      .rejects.toMatchObject({ code: "DATABASE_MIGRATION_FAILED", why: expect.stringContaining("\"0001_broken\" of the database \"default\" failed: relation \"missing_table\" does not exist") })
    expect(log).toEqual([])
  })

  it("refuses data loss before any database changes", async () => {
    const { client, queries } = fakeClient({})
    await expect(migratePostgres([{ client, database: { migrations: [{ ...migration("0000_drop", 1, ["DROP TABLE public.a"]), dataLoss: [{ reason: "drops table \"a\"", statement: "DROP TABLE public.a" }] }], name: "default" } }], { log: () => {} }))
      .rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
    expect(queries.map(([query]) => query)).not.toContain("DROP TABLE public.a")
  })

  it("leaves SQLite as it was when a Postgres database refuses", async () => {
    const { client } = fakeClient({})
    // postgres.js clients are functions.
    const postgresClient = Object.assign(() => {}, client)
    const sqliteMigrated: string[] = []
    const sqliteClient = { execute: async () => ({ rows: [] }), migrate: async () => sqliteMigrated.push("default"), protocol: "file" }
    await expect(migrateOnStart([
      { db: { $client: sqliteClient }, dialect: "sqlite", migrations: [migration("0000_init", 1, ["SELECT 1"])], name: "default" },
      { db: { $client: postgresClient }, dialect: "postgresql", migrations: [{ ...migration("0000_drop", 1, ["DROP TABLE public.a"]), dataLoss: [{ reason: "drops table \"a\"", statement: "DROP TABLE public.a" }] }], name: "orders" },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
    expect(sqliteMigrated).toEqual([])
  })

  it("migrates Definitions on one Postgres database together, in timestamp order", async () => {
    const first = fakeClient({})
    const second = fakeClient({})
    const log: string[] = []
    await migratePostgres([
      { client: first.client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"]), migration("a1", 3, ["CREATE TABLE a1 (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual([
      '[vitehub] Database "first": applied a0.',
      '[vitehub] Database "second": applied b0.',
      '[vitehub] Database "first": applied a1.',
    ])
    // One transaction on the first client runs every migration of the shared database.
    expect(second.queries.map(([query]) => query)).toEqual([expect.stringMatching(/^select current_database\(\)/)])
  })

  it("refuses a shared-database migration that Drizzle would skip", async () => {
    const ledger: Array<[number, string]> = [[1, "hash-a0"], [3, "hash-a1"]]
    const first = fakeClient({ ledger })
    const second = fakeClient({ ledger })
    await expect(migratePostgres([
      { client: first.client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"]), migration("a1", 3, ["CREATE TABLE a1 (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: () => {} })).rejects.toMatchObject({
      code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
      why: expect.stringContaining("shares its Postgres database with \"first\", and Drizzle's ledger there has no entry for migration \"b0\""),
    })
    expect(first.queries.map(([query]) => query)).not.toContain("CREATE TABLE b (id int)")
  })

  it("keeps Definitions on different Postgres databases apart", async () => {
    const first = fakeClient({ database: "one", ledger: [[3, "hash-a1"]] })
    const second = fakeClient({ database: "two" })
    const log: string[] = []
    await migratePostgres([
      { client: first.client, database: { migrations: [migration("a1", 3, ["CREATE TABLE a1 (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "second": applied b0.'])
    expect(second.queries.map(([query]) => query)).toContain("CREATE TABLE b (id int)")
  })
})
