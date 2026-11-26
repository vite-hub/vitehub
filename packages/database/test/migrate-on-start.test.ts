import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { build } from "esbuild"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createD1QueryAt } from "../src/internal/d1-ledger.ts"
import { resolveMigrateOnStart, selectMigrateOnStartDatabases } from "../src/internal/migrate-on-start.ts"
import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { findDataLoss } from "../src/internal/migration-sql.ts"
import { hubDatabase } from "../src/nuxt.ts"
import { createCloudflareD1HttpResolver } from "../src/runtime/d1-http.ts"
import { ensureDatabaseMigrations, migrateOnStart, migratePostgres, postgresMigrationLock, readPostgresDatabaseKey } from "../src/runtime/migrate-on-start.ts"
import { hubDatabase as hubDatabaseVite } from "../src/vite.ts"

import type { D1Query } from "../src/internal/d1-ledger.ts"
import type { PostgresMigrationSql } from "../src/runtime/migrate-on-start.ts"
import type { DatabaseNuxtIntegrationOptions, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

const init = { sql: "CREATE TABLE `users` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE `legacy` (`id` integer);\n", tag: "20231114221320_init", when: 1_700_000_000_000 }
const seed = { sql: "INSERT INTO `users` (`id`, `name`) VALUES (7, 'Ada');", tag: "20231114221321_seed", when: 1_700_000_001_000 }
const dropLegacy = { sql: "DROP TABLE `legacy`;", tag: "20231114221322_drop_legacy", when: 1_700_000_002_000 }

function cascadeMigrations() {
  const migration = (name: string, when: number, statements: string[]) => ({ dataLoss: findDataLoss(statements, new Map()), hash: name, name, statements, when })
  return [
    migration("0000_accounts", 1, ["CREATE TABLE `accounts` (`id` integer PRIMARY KEY NOT NULL);"]),
    migration("0001_parent", 2, [
      "CREATE TABLE `parent` (`id` integer PRIMARY KEY NOT NULL);",
      "ALTER TABLE `accounts` ADD `parent_id` integer REFERENCES parent(id) ON DELETE cascade;",
      "INSERT INTO `parent` (`id`) VALUES (1);",
      "UPDATE `accounts` SET `parent_id` = 1;",
    ]),
    migration("0002_drop_parent", 3, ["DROP TABLE `parent`;"]),
  ]
}

async function createProject() {
  const root = await mkdtemp(join(packageRoot, ".vitest-migrate-on-start-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
  await mkdir(join(root, "server/databases"), { recursive: true })
  await writeFile(join(root, "server/databases/default.ts"), [
    'import { defineDatabase } from "@vite-hub/database"',
    'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"',
    'export default defineDatabase({ schema: { users: sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) } })',
  ].join("\n"))
  return root
}

async function writeMigrations(root: string, migrations: Array<{ sql: string, tag: string, when: number }>) {
  // Drizzle Kit 1.0 writes `<YYYYMMDDHHmmss>_<name>/migration.sql`. The folder time is the `when` of each fixture.
  const dir = join(root, "server/databases/default/migrations")
  for (const migration of migrations) {
    await mkdir(join(dir, migration.tag), { recursive: true })
    await writeFile(join(dir, migration.tag, "migration.sql"), migration.sql)
  }
  return dir
}

const selectUsers = [
  'import { useDatabase } from "@vite-hub/database"',
  'const { db, schema } = useDatabase("default")',
  "console.log(JSON.stringify(await db.select().from(schema.users)))",
]

/** Runs the Nuxt module and bundles a production or prerender entry that imports Nitro's plugins first, then runs `body`. */
async function buildNodeServer(root: string, options: DatabaseNuxtIntegrationOptions, plugins: unknown[] = [], prerender = false, body = selectUsers) {
  const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  await hubDatabase(options)(undefined, {
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
    ...prerender ? ['console.log("prerendered")'] : body,
  ].join("\n"))
  const output = join(root, "server.output.mjs")
  await build({
    alias: { ...config.alias, "@vite-hub/database": join(packageRoot, "src/index.ts") },
    bundle: true,
    define: { "import.meta.prerender": String(prerender) },
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
  return { config, start: (env: Record<string, string> = {}) => execFileAsync(process.execPath, [output], { cwd: root, env: { ...process.env, ...env } }) }
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
  it.each([true, { allowDataLoss: true }] as const)("skips explicit startup migrations in Nuxt's prerender bundle (%j)", { timeout: 60_000 }, async (migrateOnStart) => {
    const root = await createProject()
    await writeMigrations(root, [init, seed, dropLegacy])
    const url = `file:${join(root, "app.sqlite")}`
    const options = { connection: { url }, migrateOnStart }
    const prerender = await buildNodeServer(root, options, [], true)
    expect((await prerender.start()).stdout).toBe("prerendered\n")
    const client = createClient({ url })
    try {
      expect((await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toEqual([])
    }
    finally {
      client.close()
    }
    // The production bundle still migrates before it serves a database query.
    await rm(join(root, "server/databases/default/migrations", dropLegacy.tag), { recursive: true })
    expect((await (await buildNodeServer(root, options)).start()).stdout).toContain('[{"id":7,"name":"Ada"}]')

    // A Postgres build does not need its runtime connection during prerendering either.
    await writeFile(join(root, "server/databases/default.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", connection: { url: process.env.MIGRATE_PRERENDER_DATABASE_URL }, schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    expect((await (await buildNodeServer(root, { migrateOnStart }, [], true)).start()).stdout).toBe("prerendered\n")
  })

  it("applies pending migrations once before a Node server handles requests, in Drizzle Kit's ledger", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const migrationsDir = await writeMigrations(root, [init, seed])
    const url = `file:${join(root, "data/app.sqlite")}`
    const server = await buildNodeServer(root, { connection: { url }, migrateOnStart: true })
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])

    const first = await server.start()
    expect(first.stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 20231114221320_init.',
      '[vitehub] Database "default": applied 20231114221321_seed.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    // The second start finds nothing pending, so the seed row is not inserted twice.
    expect((await server.start()).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(url)).toEqual([init.when, seed.when])

    // `vitehub database migrate` and Drizzle's own migrator read the same ledger and find nothing to apply.
    const database = { connection: { url }, dialect: "sqlite", generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } satisfies ResolvedDrizzleDatabaseConfig
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
    await rm(join(root, "server/databases/default.ts"))
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
        '[vitehub] Database "default": applied 20231114221320_init.',
        '[vitehub] Database "default": applied 20231114221321_seed.',
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

  it("refuses one migration name with different SQL in Definitions that share a file, and in the shared ledger", async () => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const first = createClient({ url })
    const second = createClient({ url })
    const users = { dataLoss: [], hash: "users", name: "20261109120000_init", statements: ["CREATE TABLE users (id integer PRIMARY KEY)"], when: 1_794_052_800_000 }
    const posts = { ...users, hash: "posts", statements: ["CREATE TABLE posts (id integer PRIMARY KEY)"] }
    try {
      await expect(migrateOnStart([
        { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [users], name: "default" },
        { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [posts], name: "blog" },
      ], { log: () => {} })).rejects.toThrow("It and the Database \"default\" share one SQLite file, and both have the migration \"20261109120000_init\" with different SQL.")
      expect((await first.execute("SELECT name FROM sqlite_master WHERE name IN ('users', 'posts')")).rows).toEqual([])

      // The first Definition applied its migration when it was alone on the file. The second joins with the same name.
      await migrateOnStart([{ db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [users], name: "default" }], { log: () => {} })
      await expect(migrateOnStart([
        { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [users], name: "default" },
        { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [{ ...posts, name: "20261109120000_init" }], name: "blog" },
      ], { log: () => {} })).rejects.toThrow("It and the Database \"default\" share one SQLite file")
      await expect(migrateOnStart([
        { db: drizzle({ client: second }), dialect: "sqlite" as const, migrations: [posts], name: "blog" },
        { db: drizzle({ client: first }), dialect: "sqlite" as const, migrations: [], name: "default" },
      ], { log: () => {} })).rejects.toThrow("Its shared SQLite file has already applied a migration \"20261109120000_init\" with other SQL")
      expect((await first.execute("SELECT name FROM sqlite_master WHERE name = 'posts'")).rows).toEqual([])
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
        `[vitehub] Database "${reverse ? "second" : "first"}": applied 20231114221320_init.`,
        '[vitehub] Database "second": applied 20231114221321_seed.',
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

  it("upgrades a ledger of Drizzle Kit 0.x and applies only the migrations it lacks", async () => {
    const root = await createProject()
    const url = `file:${join(root, "app.sqlite")}`
    const client = createClient({ url })
    const migration = (entry: typeof init) => ({ dataLoss: [], hash: entry.tag, name: entry.tag, statements: entry.sql.split("--> statement-breakpoint"), when: entry.when })
    try {
      // Drizzle Kit 0.x applied `init` with its journal `when` in milliseconds and no `name` column.
      await client.migrate([
        ...init.sql.split("--> statement-breakpoint"),
        "CREATE TABLE \"__drizzle_migrations\" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)",
        { args: [init.tag, init.when + 417], sql: "INSERT INTO \"__drizzle_migrations\" (hash, created_at) VALUES (?, ?)" },
      ])
      const applied: string[] = []
      await migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations: [migration(init), migration(seed)], name: "default" }], { log: message => applied.push(message) })
      expect(applied).toEqual([`[vitehub] Database "default": applied ${seed.tag}.`])
      expect((await client.execute("SELECT name FROM __drizzle_migrations ORDER BY id")).rows.map(row => row[0])).toEqual([init.tag, seed.tag])
      await migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations: [migration(init), migration(seed)], name: "default" }], { log: message => applied.push(message) })
      expect(applied).toHaveLength(1)
    }
    finally {
      client.close()
    }
  })

  it("refuses a ledger of Drizzle Kit 0.x with a row that matches no migration folder", async () => {
    const root = await createProject()
    const url = `file:${join(root, "app.sqlite")}`
    const client = createClient({ url })
    try {
      await client.migrate([
        "CREATE TABLE \"__drizzle_migrations\" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)",
        { args: ["gone", 1_600_000_000_000], sql: "INSERT INTO \"__drizzle_migrations\" (hash, created_at) VALUES (?, ?)" },
      ])
      const migrations = [{ dataLoss: [], hash: init.tag, name: init.tag, statements: init.sql.split("--> statement-breakpoint"), when: init.when }]
      await expect(migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations, name: "default" }], { log: () => {} })).rejects.toMatchObject({
        code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
        why: expect.stringContaining("match no migration folder"),
      })
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'users'")).rows).toEqual([])
    }
    finally {
      client.close()
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
    expect((await allowed.start()).stdout).toContain('[vitehub] Database "default": applied 20231114221322_drop_legacy.')
    expect(await readLedger(url)).toEqual([init.when, seed.when, dropLegacy.when])
  })

  it("accepts the data loss at start when VITEHUB_DATABASE_ALLOW_DATA_LOSS=1 is set", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const url = `file:${join(root, "data/app.sqlite")}`
    await writeMigrations(root, [init, seed])
    await (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()

    // A container image is built once, so the operator accepts the loss with an environment variable at start.
    await writeMigrations(root, [init, seed, dropLegacy])
    const server = await buildNodeServer(root, { connection: { url }, migrateOnStart: true })
    await expect(server.start({ VITEHUB_DATABASE_ALLOW_DATA_LOSS: "true" })).rejects.toThrow(/VITEHUB_DATABASE_ALLOW_DATA_LOSS=1/)
    expect(await readLedger(url)).toEqual([init.when, seed.when])
    expect((await server.start({ VITEHUB_DATABASE_ALLOW_DATA_LOSS: "1" })).stdout).toContain('[vitehub] Database "default": applied 20231114221322_drop_legacy.')
    expect(await readLedger(url)).toEqual([init.when, seed.when, dropLegacy.when])
  })

  it("applies a drop of a table that the same start creates, without allowDataLoss", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const migrationsDir = await writeMigrations(root, [init, seed, dropLegacy])
    const url = `file:${join(root, "data/app.sqlite")}`
    const started = await (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()
    expect(started.stdout).toContain('[vitehub] Database "default": applied 20231114221322_drop_legacy.')
    expect(await readLedger(url)).toEqual([init.when, seed.when, dropLegacy.when])

    // `vitehub database migrate --dry-run` reads the same run on a new file and finds no data loss either.
    const database = { connection: { url: `file:${join(root, "data/new.sqlite")}` }, dialect: "sqlite", generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } satisfies ResolvedDrizzleDatabaseConfig
    const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toBeUndefined()
    expect(plan?.pending.map(migration => [migration.name, migration.dataLoss])).toEqual([[init.tag, []], [seed.tag, []], [dropLegacy.tag, []]])
  })

  it("skips a migration chunk that holds only comments", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const commented = { ...seed, sql: `-- Sample rows.\n--> statement-breakpoint\n${seed.sql}\n--> statement-breakpoint\n/* The end. */\n` }
    await writeMigrations(root, [init, commented])
    const url = `file:${join(root, "data/app.sqlite")}`
    const started = await (await buildNodeServer(root, { connection: { url }, migrateOnStart: true })).start()
    expect(started.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(url)).toEqual([init.when, seed.when])
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
        message: expect.stringContaining("20231114221322_drop_legacy: drops table \"legacy\""),
      })
      expect(await readLedger(url)).toEqual([init.when])
    }
    finally {
      client.close()
    }
  })

  it("refuses to drop a new table whose foreign key cascades into older SQLite rows", async () => {
    const url = `file:${join(await createProject(), "app.sqlite")}`
    const client = createClient({ url })
    try {
      await client.execute("PRAGMA foreign_keys = ON")
      const migrations = cascadeMigrations()
      await migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations: migrations.slice(0, 1), name: "default" }], { log: () => {} })
      await client.execute("INSERT INTO accounts (id) VALUES (1)")
      await expect(migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations, name: "default" }], { log: () => {} })).rejects.toMatchObject({
        code: "DATABASE_MIGRATION_DATA_LOSS",
        message: expect.stringContaining("0002_drop_parent: drops table \"parent\""),
      })
      expect((await client.execute("SELECT id FROM accounts")).rows.map(row => row.id)).toEqual([1])
    }
    finally {
      client.close()
    }
  })

  it("adds the plugin only to production Node builds of the Vite integration", async () => {
    const root = await createProject()
    await writeMigrations(root, [init])
    const setup = async (options: { dev?: boolean, preset?: string }) => {
      const plugin = hubDatabaseVite({ migrateOnStart: true })
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [], root })
      const nitroOptions: Parameters<typeof plugin.nitro.setup>[0]["options"] = { ...options, output: { serverDir: join(root, ".output/server") } }
      plugin.nitro.setup({ hooks: { hook: () => {} }, options: nitroOptions })
      return nitroOptions.plugins
    }
    expect(await setup({ preset: "node-server" })).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect(await setup({})).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    // `vite dev` gets only the plugin that shares the app's Databases with packages that Node loads.
    expect(await setup({ dev: true, preset: "node-server" })).toEqual([join(root, ".vitehub/nitro/database/dev-registry.mjs")])
    expect(await setup({ preset: "nitro-prerender" })).toBeUndefined()
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
      await hubDatabase({ migrateOnStart: true })(undefined, {
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
    const migration = (dataLoss: Array<{ reason: string, statement: string }>) => ({ dataLoss, hash: "hash", name: "20231114221320_init", statements: ["SELECT 1"], when: 1 })
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

/**
 * A D1 HTTP proxy on a local port, backed by a SQLite file. Like D1, a request with many statements changes all or
 * nothing, and a single query answers in the `/raw` shape that the runtime reads.
 */
async function startD1Proxy(root: string, rowlessWrites = false) {
  const client = createClient({ url: `file:${join(root, "d1.db")}` })
  const requests: string[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => body += chunk)
    request.on("end", async () => {
      const send = (status: number, payload: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
      if (request.headers.authorization !== "Bearer proxy-token") return send(401, { errors: [{ message: "bad token" }], success: false })
      const { params = [], sql } = JSON.parse(body) as { params?: Array<string | number | null>, sql: string }
      requests.push(sql)
      try {
        if (/^\s*(?:SELECT|INSERT[^;]*RETURNING)/i.test(sql) && !sql.trim().replace(/;$/, "").includes(";")) {
          const result = await client.execute({ args: params, sql })
          return send(200, { result: [{ results: { columns: result.columns, rows: result.rows.map(row => result.columns.map((_, index) => row[index])) }, success: true }], success: true })
        }
        await client.executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`)
        send(200, { result: [{ ...(!rowlessWrites && { results: { columns: [], rows: [] } }), success: true }], success: true })
      }
      catch (error) {
        await client.execute("ROLLBACK").catch(() => {})
        send(400, { errors: [{ code: 7500, message: String(error) }], result: [], success: false })
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/d1/raw`
  const rows = async (sql: string) => {
    const result = await client.execute(sql)
    return result.rows.map(row => result.columns.map((_, index) => row[index]))
  }
  return { close: () => new Promise<void>(resolve => server.close(() => { client.close(); resolve() })), requests, rows, url }
}

/**
 * Cloudflare's D1 `/query` API as a `fetch` that never leaves the process, backed by a SQLite file. It answers in the
 * shape of the real API: rows as objects, and HTTP 400 with `errors` when a statement fails. Like D1, a request with
 * many statements changes all or nothing.
 */
function mockCloudflareD1Api(root: string, accountId: string, databaseId: string) {
  const client = createClient({ url: `file:${join(root, "cloudflare-d1.db")}` })
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`
  const requests: Array<{ authorization: string | null, sql: string, url: string }> = []
  const reply = (status: number, payload: Record<string, unknown>) => Response.json({ errors: [], messages: [], ...payload }, { status })
  const request = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    const { params = [], sql } = JSON.parse(String(init?.body)) as { params?: Array<string | number | null>, sql: string }
    requests.push({ authorization: new Headers(init?.headers).get("authorization"), sql, url })
    if (url !== endpoint) return reply(404, { errors: [{ code: 7404, message: "Not found" }], result: null, success: false })
    try {
      if (!sql.trim().replace(/;$/, "").includes(";")) {
        const result = await client.execute({ args: params, sql })
        const results = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
        return reply(200, { result: [{ meta: { changes: result.rowsAffected }, results, success: true }], success: true })
      }
      await client.executeMultiple(`BEGIN;\n${sql}\nCOMMIT;`)
      return reply(200, { result: [{ meta: {}, results: [], success: true }], success: true })
    }
    catch (error) {
      await client.execute("ROLLBACK").catch(() => {})
      return reply(400, { errors: [{ code: 7500, message: `${String(error)}: SQLITE_CONSTRAINT` }], result: [], success: false })
    }
  }
  const rows = async (sql: string) => {
    const result = await client.execute(sql)
    return result.rows.map(row => result.columns.map((_, index) => row[index]))
  }
  return { close: () => client.close(), endpoint, request, requests, rows }
}

describe("migrateOnStart with Cloudflare D1 over HTTP", () => {
  async function createD1Project(opaque = false) {
    const root = await createProject()
    await writeFile(join(root, "server/databases/default.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"',
      ...(opaque ? ['const d1 = { databaseId: "drop-d1", http: { authToken: process.env.D1_HTTP_TOKEN, url: process.env.D1_HTTP_URL }, migrationsTable: ["custom", "history"].join("_") }'] : []),
      "export default defineDatabase({",
      opaque ? "  cloudflare: d1," : '  cloudflare: { databaseId: "drop-d1", http: { authToken: process.env.D1_HTTP_TOKEN, url: process.env.D1_HTTP_URL } },',
      '  schema: { users: sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) },',
      "})",
    ].join("\n"))
    return root
  }

  it("applies pending migrations in Wrangler's d1_migrations table before a Node server handles requests", { timeout: 60_000 }, async () => {
    const root = await createD1Project()
    const migrationsDir = await writeMigrations(root, [init, seed])
    const d1 = await startD1Proxy(root, true)
    try {
      const server = await buildNodeServer(root, { migrateOnStart: true })
      expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
      // The build keeps the Wrangler name of each folder, as a Cloudflare build does.
      expect(JSON.parse(readFileSync(join(migrationsDir, "d1-migrations.json"), "utf8"))).toEqual({ [init.tag]: "0000_init.sql", [seed.tag]: "0001_seed.sql" })
      const env = { D1_HTTP_TOKEN: "proxy-token", D1_HTTP_URL: d1.url }

      expect((await server.start(env)).stdout.trim().split("\n")).toEqual([
        '[vitehub] Database "default": applied 20231114221320_init.',
        '[vitehub] Database "default": applied 20231114221321_seed.',
        JSON.stringify([{ id: 7, name: "Ada" }]),
      ])
      // The second start finds nothing pending, so the seed row is not inserted twice.
      expect((await server.start(env)).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_seed.sql"]])

      // `vitehub database migrate` reads the same table and finds nothing to apply.
      const database = { cloudflare: { databaseId: "drop-d1", http: { authToken: "proxy-token", url: d1.url }, migrationsDir }, dialect: "sqlite", generatedSchemaFile: "", migrationsDir, mode: "default", name: "default", orm: "drizzle" } as ResolvedDrizzleDatabaseConfig
      const [error, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
      expect(error).toBeUndefined()
      expect(plan?.pending).toEqual([])
    }
    finally {
      await d1.close()
    }
  })

  it("uses the effective D1 config when the build cannot project it", { timeout: 60_000 }, async () => {
    const root = await createD1Project(true)
    await writeMigrations(root, [init, seed])
    const d1 = await startD1Proxy(root)
    try {
      await d1.rows(init.sql.split("--> statement-breakpoint")[0]!)
      await d1.rows('CREATE TABLE "legacy" ("id" integer)')
      await d1.rows('CREATE TABLE custom_history (id INTEGER PRIMARY KEY, name TEXT UNIQUE)')
      await d1.rows("INSERT INTO custom_history (name) VALUES ('0000_init.sql')")
      const server = await buildNodeServer(root, { migrateOnStart: true })
      const { stdout } = await server.start({ D1_HTTP_TOKEN: "proxy-token", D1_HTTP_URL: d1.url })
      expect(stdout).toContain(JSON.stringify([{ id: 7, name: "Ada" }]))
      await expect(d1.rows("SELECT name FROM custom_history ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_seed.sql"]])
      await expect(d1.rows("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).resolves.toEqual([])
    }
    finally {
      await d1.close()
    }
  })

  it("rejects incomplete D1 history even when no migration has SQL", async () => {
    const root = await createD1Project()
    const folder = join(root, "server/databases/default/migrations", init.tag)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "snapshot.json"), "{}")
    await expect(buildNodeServer(root, { migrateOnStart: true })).rejects.toThrow("migration.sql")
  })

  function d1Database(name: string, target: string, migrations: (typeof init)[], query: D1Query) {
    const files = migrations.map((migration, index) => ({ dataLoss: findDataLoss([migration.sql]), name: `000${index}_migration.sql`, sql: migration.sql, statements: migration.sql.split("--> statement-breakpoint"), tag: migration.tag }))
    return { d1: { files }, db: { $client: { migrationsTable: "d1_migrations", protocol: "d1-http", query, target } }, dialect: "sqlite" as const, migrations: [], name }
  }

  it("rejects two Definitions sharing a D1 ledger before either writes", async () => {
    const requests: string[] = []
    const query = async (sql: string) => {
      requests.push(sql)
      return []
    }
    const first = d1Database("notes", "https://proxy.example/d1", [{ ...init, sql: "CREATE TABLE notes (id integer);" }], query)
    const second = d1Database("messages", "https://proxy.example/d1", [{ ...init, sql: "CREATE TABLE messages (id integer);" }], query)
    await expect(migrateOnStart([first, second])).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED", why: expect.stringContaining("d1_migrations") })
    expect(requests).toEqual([])
  })

  it("requires rows when reading a D1 ledger", async () => {
    const query = createD1QueryAt("https://proxy.example/d1", "token", problem => new Error(problem), async () => Response.json({ result: [{ success: true }], success: true }))
    await expect(query("SELECT name FROM d1_migrations")).rejects.toThrow("HTTP 200")
  })

  it("lets a fresh D1 database drop a table that an earlier pending file creates, in one request", { timeout: 60_000 }, async () => {
    const root = await createD1Project()
    await writeMigrations(root, [init, dropLegacy])
    const d1 = await startD1Proxy(root)
    try {
      const server = await buildNodeServer(root, { migrateOnStart: true })
      const { stdout } = await server.start({ D1_HTTP_TOKEN: "proxy-token", D1_HTTP_URL: d1.url })
      expect(stdout).toContain('[vitehub] Database "default": applied 20231114221322_drop_legacy.')
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_drop_legacy.sql"]])
      await expect(d1.rows("SELECT name FROM sqlite_master WHERE name = 'legacy'")).resolves.toEqual([])
      expect(d1.requests.filter(sql => sql.includes("CREATE TABLE `legacy`"))).toEqual([expect.stringContaining("DROP TABLE `legacy`")])
    }
    finally {
      await d1.close()
    }
  })

  it("refuses to drop a D1 table that an earlier start created", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      const query = createD1QueryAt(d1.url, "proxy-token", problem => new Error(problem))
      await migrateOnStart([d1Database("default", d1.url, [init], query)], { log: () => {} })
      await d1.rows("INSERT INTO legacy (id) VALUES (1)")
      await expect(migrateOnStart([d1Database("default", d1.url, [init, dropLegacy], query)], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
      await expect(d1.rows("SELECT id FROM legacy")).resolves.toEqual([[1]])
    }
    finally {
      await d1.close()
    }
  })

  it("refuses to drop a new D1 table whose foreign key cascades into older rows", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      await d1.rows("PRAGMA foreign_keys = ON")
      const query = createD1QueryAt(d1.url, "proxy-token", problem => new Error(problem))
      const files = cascadeMigrations().map(migration => ({ sql: migration.statements.join("\n"), tag: migration.name, when: migration.when }))
      await migrateOnStart([d1Database("default", d1.url, files.slice(0, 1), query)], { log: () => {} })
      await d1.rows("INSERT INTO accounts (id) VALUES (1)")
      await expect(migrateOnStart([d1Database("default", d1.url, files, query)], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
      await expect(d1.rows("SELECT id FROM accounts")).resolves.toEqual([[1]])
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0000_migration.sql"]])
    }
    finally {
      await d1.close()
    }
  })

  it("refuses a full delete from a new D1 table when its trigger can remove older rows", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      const query = createD1QueryAt(d1.url, "proxy-token", problem => new Error(problem))
      const createAccounts = { ...init, sql: "CREATE TABLE accounts (id integer PRIMARY KEY);" }
      const files = [
        createAccounts,
        {
          sql: [
            "CREATE TABLE scratch (id integer PRIMARY KEY);",
            "CREATE TRIGGER remove_account AFTER DELETE ON scratch BEGIN DELETE FROM accounts WHERE id = OLD.id; END;",
            "INSERT INTO scratch VALUES (1);",
          ].join("\n"),
          tag: "create_scratch",
          when: init.when,
        },
        { sql: "DELETE FROM scratch;", tag: "clear_scratch", when: init.when },
      ]
      await migrateOnStart([d1Database("default", d1.url, [createAccounts], query)], { log: () => {} })
      await d1.rows("INSERT INTO accounts (id) VALUES (1)")
      await expect(migrateOnStart([d1Database("default", d1.url, files, query)], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_DATA_LOSS" })
      await expect(d1.rows("SELECT id FROM accounts")).resolves.toEqual([[1]])
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0000_migration.sql"]])
    }
    finally {
      await d1.close()
    }
  })

  it("goes on when another server applied a batch of more than 100 files first", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      const fillers = Array.from({ length: 100 }, (_, index) => ({ sql: `CREATE TABLE filler_${index} (id integer);`, tag: `filler_${index}`, when: init.when }))
      const database = d1Database("default", d1.url, [init, ...fillers, dropLegacy], async () => [])
      const direct = createD1QueryAt(d1.url, "proxy-token", problem => new Error(problem))
      let olderServerApplied = false
      const olderServerAppliesAllFirst: D1Query = async (sql, params = [], mode) => {
        if (params.length > 100) throw new Error("D1 allows 100 bound parameters")
        if (!olderServerApplied && sql.includes("DROP TABLE `legacy`")) {
          olderServerApplied = true
          await direct(sql, undefined, "write")
        }
        return direct(sql, params, mode)
      }
      const log: string[] = []
      await migrateOnStart([{ ...database, db: { $client: { ...database.db.$client, query: olderServerAppliesAllFirst } } }], { log: message => log.push(message) })
      expect(log).toEqual([])
      await expect(d1.rows("SELECT count(*) FROM d1_migrations")).resolves.toEqual([[102]])
    }
    finally {
      await d1.close()
    }
  })

  it("keeps the rows of a D1 table that another server creates after the plan", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      const direct = createD1QueryAt(d1.url, "proxy-token", problem => new Error(problem))
      const olderServerAppliesInitFirst: D1Query = async (sql, params, mode) => {
        if (sql.includes("DROP TABLE `legacy`")) {
          await direct(`${init.sql.replaceAll("--> statement-breakpoint", "")}\n;\nINSERT INTO d1_migrations (name) VALUES ('0000_migration.sql');\nINSERT INTO legacy (id) VALUES (1);`, undefined, "write")
        }
        return direct(sql, params, mode)
      }
      await expect(migrateOnStart([d1Database("default", d1.url, [init, dropLegacy], olderServerAppliesInitFirst)], { log: () => {} })).rejects.toThrow()
      await expect(d1.rows("SELECT id FROM legacy")).resolves.toEqual([[1]])
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0000_migration.sql"]])
    }
    finally {
      await d1.close()
    }
  })

  it("refuses a pending migration that loses data before it changes D1, unless allowDataLoss is set", { timeout: 60_000 }, async () => {
    const root = await createD1Project()
    await writeMigrations(root, [init, seed])
    const d1 = await startD1Proxy(root)
    const env = { D1_HTTP_TOKEN: "proxy-token", D1_HTTP_URL: d1.url }
    try {
      await (await buildNodeServer(root, { migrateOnStart: true })).start(env)
      await writeMigrations(root, [init, seed, dropLegacy])
      await expect((await buildNodeServer(root, { migrateOnStart: true })).start(env)).rejects.toThrow(/DATABASE_MIGRATION_DATA_LOSS/)
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_seed.sql"]])

      expect((await (await buildNodeServer(root, { migrateOnStart: { allowDataLoss: true } })).start(env)).stdout).toContain('[vitehub] Database "default": applied 20231114221322_drop_legacy.')
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_seed.sql"], ["0002_drop_legacy.sql"]])
    }
    finally {
      await d1.close()
    }
  })

  it("goes on when another server applied the same migration first", async () => {
    const root = await createD1Project()
    const d1 = await startD1Proxy(root)
    try {
      const file = { dataLoss: [], name: "0000_init.sql", sql: init.sql, statements: init.sql.split("--> statement-breakpoint"), tag: init.tag }
      const startMigration = { dataLoss: [], hash: init.tag, name: init.tag, statements: file.statements, when: init.when }
      const query = async (sql: string, params: unknown[] = []) => {
        const response = await fetch(d1.url, { body: JSON.stringify({ params, sql }), headers: { authorization: "Bearer proxy-token" }, method: "POST" })
        const payload = await response.json() as { result: Array<{ results: { rows: unknown[][] } }> }
        if (!response.ok) throw new Error(JSON.stringify(payload))
        return payload.result.at(-1)!.results.rows
      }
      // Both servers read the tables before either one applies the migration.
      let release!: () => void
      const bothRead = new Promise<void>(resolve => release = resolve)
      let reads = 0
      const racing = async (sql: string, params?: unknown[]) => {
        const rows = await query(sql, params)
        if (sql.startsWith("SELECT name FROM sqlite_master") && ++reads === 2) release()
        if (sql.startsWith("SELECT name FROM sqlite_master")) await bothRead
        return rows
      }
      const database = { d1: { files: [file] }, db: { $client: { migrationsTable: "d1_migrations", protocol: "d1-http", query: racing, target: d1.url } }, dialect: "sqlite" as const, migrations: [startMigration], name: "default" }
      const first: string[] = []
      const second: string[] = []
      await Promise.all([
        migrateOnStart([database], { log: message => first.push(message) }),
        migrateOnStart([database], { log: message => second.push(message) }),
      ])
      expect(d1.requests.filter(sql => sql.includes("CREATE TABLE `users`"))).toHaveLength(2)
      await expect(d1.rows("SELECT name FROM d1_migrations")).resolves.toEqual([["0000_init.sql"]])
      expect([...first, ...second]).toEqual(['[vitehub] Database "default": applied 20231114221320_init.'])
    }
    finally {
      await d1.close()
    }
  })

  it("applies each migration once through Cloudflare's D1 API when two servers start together on a fresh database", async () => {
    const root = await createProject()
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "drop-account")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-token")
    const api = mockCloudflareD1Api(root, "drop-account", "drop-d1")
    const users = sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() })
    const relations = defineRelations({ users })
    // This seed succeeds twice on its own, so only D1's rollback of the second copy keeps one row.
    const grace = { sql: "INSERT INTO `users` (`name`) VALUES ('Grace');", tag: "20231114221321_seed", when: seed.when }
    const statements = (migration: typeof init) => migration.sql.split("--> statement-breakpoint")
    const files = [init, grace].map((migration, index) => ({ dataLoss: [], name: `000${index}_${migration.tag.split("_")[1]}.sql`, sql: migration.sql, statements: statements(migration), tag: migration.tag }))
    const migrations = [init, grace].map(migration => ({ dataLoss: [], hash: migration.tag, name: migration.tag, statements: statements(migration), when: migration.when }))
    // Both servers read the ledger before either one applies a migration.
    let release!: () => void
    const bothRead = new Promise<void>(resolve => release = resolve)
    let reads = 0
    const racing: typeof fetch = async (input, options) => {
      const response = await api.request(input, options)
      if (String(options?.body).includes("FROM sqlite_master")) {
        if (++reads === 2) release()
        await bothRead
      }
      return response
    }
    // Each server builds its own client, as two processes do.
    const start = (log: string[]) => {
      const db = createCloudflareD1HttpResolver({ cloudflare: { databaseId: "drop-d1", http: true }, name: "default" }, relations, racing)()
      return migrateOnStart([{ d1: { files }, db, dialect: "sqlite", migrations, name: "default" }], { log: message => log.push(message) })
    }
    try {
      const first: string[] = []
      const second: string[] = []
      await Promise.all([start(first), start(second)])
      expect([...first, ...second].sort()).toEqual([
        '[vitehub] Database "default": applied 20231114221320_init.',
        '[vitehub] Database "default": applied 20231114221321_seed.',
      ])
      // Each server sent each migration. D1 rolled back the second copy, because its ledger row was not unique.
      expect(api.requests.filter(request => request.sql.includes("INSERT INTO `users`"))).toHaveLength(2)
      await expect(api.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0000_init.sql"], ["0001_seed.sql"]])
      await expect(api.rows("SELECT name FROM users")).resolves.toEqual([["Grace"]])

      // A later start reads the ledger and writes nothing.
      const sent = api.requests.length
      await start([])
      expect(api.requests.slice(sent).map(request => request.sql).filter(sql => !sql.startsWith("SELECT "))).toEqual([])
      expect(api.requests.every(request => request.url === api.endpoint && request.authorization === "Bearer cloudflare-token")).toBe(true)
    }
    finally {
      api.close()
    }
  })

  it("adopts the ledger of Drop's own D1 migrator, and numbers a new folder that d1-migrations.json does not list", { timeout: 60_000 }, async () => {
    const root = await createD1Project()
    const migrationsDir = await writeMigrations(root, [init, seed])
    // Drop's `scripts/migrate-d1.mjs` applied the listed folder into Wrangler's table. Then `drizzle-kit generate`
    // wrote the seed folder, and nothing listed it, so that script would never apply it.
    await writeFile(join(migrationsDir, "d1-migrations.json"), `${JSON.stringify({ [init.tag]: "0004_init.sql" })}\n`)
    const d1 = await startD1Proxy(root)
    try {
      for (const statement of init.sql.split("--> statement-breakpoint")) await d1.rows(statement)
      await d1.rows("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)")
      await d1.rows("INSERT INTO d1_migrations (name) VALUES ('0004_init.sql')")

      const server = await buildNodeServer(root, { migrateOnStart: true })
      // The build gives the new folder the next number, as `vitehub database migrate` does.
      expect(JSON.parse(readFileSync(join(migrationsDir, "d1-migrations.json"), "utf8"))).toEqual({ [init.tag]: "0004_init.sql", [seed.tag]: "0005_seed.sql" })
      expect((await server.start({ D1_HTTP_TOKEN: "proxy-token", D1_HTTP_URL: d1.url })).stdout.trim().split("\n")).toEqual([
        '[vitehub] Database "default": applied 20231114221321_seed.',
        JSON.stringify([{ id: 7, name: "Ada" }]),
      ])
      await expect(d1.rows("SELECT name FROM d1_migrations ORDER BY id")).resolves.toEqual([["0004_init.sql"], ["0005_seed.sql"]])
    }
    finally {
      await d1.close()
    }
  })

  it("ships the Wrangler names of the migrations in a Vite Node build, and adds the start plugin", async () => {
    const root = await createD1Project()
    await writeMigrations(root, [init, seed])
    const plugin = hubDatabaseVite({ migrateOnStart: true })
    const nitro = { options: { dev: false, plugins: [] as string[], preset: "node-server" }, hooks: { hook: () => {} } }
    await (plugin.nitro as { setup: (nitro: unknown) => void }).setup(nitro)
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ command: "build", nitro: nitro.options, plugins: [], root })
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const id = (plugin.resolveId as { handler: (id: string) => string | undefined }).handler("#vitehub/database/migrations")
    // SAFETY: These are Vite hook handlers returned by hubDatabase.
    const shipped = JSON.parse((await (plugin.load as { handler: (id: string) => Promise<string> | undefined }).handler(id!))!.replace(/^export default /, ""))
    expect(shipped.databases.default.d1).toMatchObject({ files: [{ name: "0000_init.sql", tag: init.tag }, { name: "0001_seed.sql", tag: seed.tag }] })
    expect(nitro.options.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
  })

  it("rejects a backup of a D1 HTTP database", async () => {
    const query = async () => []
    await expect(migrateOnStart([d1Database("default", "https://proxy.example/d1", [], query)], { backup: { keep: 3 } })).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_BACKUP_UNSUPPORTED",
      why: expect.stringContaining("D1 over HTTP"),
    })
  })
})

describe("migrateOnStart backup", () => {
  const grace = { sql: "INSERT INTO `users` (`id`, `name`) VALUES (8, 'Grace');", tag: "20231114221323_grace", when: 1_700_000_003_000 }
  const linus = { sql: "INSERT INTO `users` (`id`, `name`) VALUES (9, 'Linus');", tag: "20231114221324_linus", when: 1_700_000_004_000 }
  const startMigration = (entry: { sql: string, tag: string, when: number }) => ({ dataLoss: [], hash: entry.tag, name: entry.tag, statements: entry.sql.split("--> statement-breakpoint"), when: entry.when })
  const copyName = /^app-(?:[a-f0-9]{64}-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-before-(.+)\.sqlite$/

  /** Runs `migrateOnStart()` on a SQLite file with the migrations `entries`, and returns the log lines. */
  async function start(file: string, entries: Array<{ sql: string, tag: string, when: number }>, backup: { dir?: string, keep: number }) {
    const client = createClient({ url: `file:${file}` })
    const logs: string[] = []
    try {
      await migrateOnStart([{ db: drizzle({ client }), dialect: "sqlite" as const, migrations: entries.map(startMigration), name: "default" }], { backup, log: message => logs.push(message) })
      return logs
    }
    finally {
      client.close()
    }
  }

  async function sqliteFile() {
    const root = await mkdtemp(join(packageRoot, ".vitest-migrate-backup-"))
    roots.push(root)
    return { backups: join(root, "backups"), file: join(root, "app.sqlite"), root }
  }

  it("copies a SQLite file before its pending migrations, and only when one is pending", async () => {
    const { backups, file } = await sqliteFile()
    // A new database has nothing to keep.
    await start(file, [init], { keep: 3 })
    expect(existsSync(backups)).toBe(false)

    const logs = await start(file, [init, seed], { keep: 3 })
    const copies = await readdir(backups)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(copyName)
    expect(copies[0]!.match(copyName)![1]).toBe(seed.tag)
    expect(logs[0]).toBe(`[vitehub] Database "default": copied ${file} to ${join(backups, copies[0]!)} before 1 migration(s).`)
    // The copy is the database before the start: the table without the seed row, and the ledger with `init` only.
    expect(await readLedger(`file:${join(backups, copies[0]!)}`)).toEqual([init.when])
    expect(await readLedger(`file:${file}`)).toEqual([init.when, seed.when])

    // Nothing is pending, so the next start makes no copy.
    expect(await start(file, [init, seed], { keep: 3 })).toEqual([])
    expect(await readdir(backups)).toEqual(copies)
  })

  it("keeps the newest copies of each file, and leaves other files in the folder", async () => {
    const { file, root } = await sqliteFile()
    const dir = join(root, "copies")
    await mkdir(dir)
    await writeFile(join(dir, "notes.txt"), "kept")
    await writeFile(join(dir, "app-old-2023-11-14T22-13-20-000Z-before-x.sqlite"), "kept")
    await start(file, [init], { dir, keep: 2 })
    // Three starts, each with one new migration, make three copies.
    for (const count of [2, 3, 4]) await start(file, [init, seed, grace, linus].slice(0, count), { dir, keep: 2 })
    const names = (await readdir(dir)).sort()
    expect(names.filter(name => copyName.test(name)).map(name => name.match(copyName)![1])).toEqual([grace.tag, linus.tag])
    expect(names).toEqual(expect.arrayContaining(["notes.txt", "app-old-2023-11-14T22-13-20-000Z-before-x.sqlite"]))
  })

  it("retains independent readable copies of same-named files in a shared directory", async () => {
    const { file: first, root } = await sqliteFile()
    const second = join(root, "second", "app.sqlite")
    const dir = join(root, "copies")
    await mkdir(join(root, "second"))
    for (const file of [first, second]) {
      await start(file, [init], { dir, keep: 1 })
      await start(file, [init, seed], { dir, keep: 1 })
    }
    expect(await readdir(dir)).toHaveLength(2)
    // Prune one file's older copy without removing the other file's restore point.
    await start(first, [init, seed, grace], { dir, keep: 1 })
    const copies = await readdir(dir)
    expect(copies).toHaveLength(2)
    const ledgers = await Promise.all(copies.map(name => readLedger(`file:${join(dir, name)}`)))
    expect(ledgers).toEqual(expect.arrayContaining([[init.when], [init.when, seed.when]]))
  })

  it("stops the start before any migration when the copy fails", async () => {
    const { file, root } = await sqliteFile()
    await start(file, [init], { keep: 3 })
    // A file where the folder should be makes the copy fail.
    const dir = join(root, "not-a-folder")
    await writeFile(dir, "")
    await expect(start(file, [init, seed], { dir, keep: 3 })).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_BACKUP_FAILED",
      why: expect.stringContaining("The server applied no migration."),
    })
    expect(await readLedger(`file:${file}`)).toEqual([init.when])
  })

  it("rejects databases that it cannot copy, and an invalid keep", async () => {
    const backup = resolveMigrateOnStart({ migrateOnStart: { backup: true } })!
    expect(backup).toEqual({ allowDataLoss: false, backup: { keep: 3 }, explicit: true })
    expect(resolveMigrateOnStart({ migrateOnStart: { backup: { dir: "data/backups", keep: 5 } } })).toEqual({ allowDataLoss: false, backup: { dir: "data/backups", keep: 5 }, explicit: true })
    for (const keep of [0, 1.5]) {
      expect(() => resolveMigrateOnStart({ migrateOnStart: { backup: { keep } } })).toThrow(expect.objectContaining({ code: "DATABASE_MIGRATION_BACKUP_UNSUPPORTED" }))
    }

    const config = (database: Record<string, unknown>) => ({ databaseNames: ["default"], databases: { default: database } }) as unknown as ResolvedDBViteConfig
    expect(selectMigrateOnStartDatabases(config({ connection: { url: "file:data/app.sqlite" }, dialect: "sqlite" }), backup, "node")).toEqual(["default"])
    for (const [database, problem] of [
      [{ dialect: "postgresql" }, "It is a Postgres database."],
      [{ connection: { url: "libsql://app.turso.io" }, dialect: "sqlite" }, "It uses remote libSQL."],
      [{ connection: { url: ":memory:" }, dialect: "sqlite" }, "It is in memory."],
    ] as const) {
      expect(() => selectMigrateOnStartDatabases(config(database), backup, "node")).toThrow(expect.objectContaining({
        code: "DATABASE_MIGRATION_BACKUP_UNSUPPORTED",
        why: expect.stringContaining(problem),
      }))
    }

    // A URL from the environment is checked when the server starts.
    const memory = createClient({ url: ":memory:" })
    try {
      await expect(migrateOnStart([{ db: drizzle({ client: memory }), dialect: "sqlite" as const, migrations: [startMigration(init)], name: "default" }], { backup: { keep: 3 } })).rejects.toMatchObject({
        code: "DATABASE_MIGRATION_BACKUP_UNSUPPORTED",
        why: expect.stringContaining("It is in memory."),
      })
    }
    finally {
      memory.close()
    }
    await expect(migrateOnStart([{ db: {}, dialect: "postgresql" as const, migrations: [], name: "analytics" }], { backup: { keep: 3 } })).rejects.toMatchObject({
      code: "DATABASE_MIGRATION_BACKUP_UNSUPPORTED",
      why: expect.stringContaining("It is a Postgres database."),
    })
  })

  it("backs up a Nuxt Node server's SQLite file in a backups folder beside it", { timeout: 60_000 }, async () => {
    const root = await createProject()
    const file = join(root, "data/app.sqlite")
    const options = { connection: { url: `file:${file}` }, migrateOnStart: { backup: true } }
    await writeMigrations(root, [init])
    await (await buildNodeServer(root, options)).start()
    expect(existsSync(join(root, "data/backups"))).toBe(false)

    await writeMigrations(root, [init, seed])
    const started = await (await buildNodeServer(root, options)).start()
    const copies = await readdir(join(root, "data/backups"))
    expect(copies).toHaveLength(1)
    expect(started.stdout.trim().split("\n")).toEqual([
      `[vitehub] Database "default": copied ${file} to ${join(root, "data/backups", copies[0]!)} before 1 migration(s).`,
      '[vitehub] Database "default": applied 20231114221321_seed.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
  })
})

describe("ensureMigrations", () => {
  // Parallel calls and a later call, then the rows of `users`.
  const ensureThenSelect = [
    'import { ensureMigrations } from "@vite-hub/database"',
    'await Promise.all([ensureMigrations(), ensureMigrations("default")])',
    "await ensureMigrations()",
    ...selectUsers,
  ]

  it("applies the migrations once from a server without the start plugin", { timeout: 60_000 }, async () => {
    const root = await createProject()
    await writeMigrations(root, [init, seed])
    const url = `file:${join(root, "data/app.sqlite")}`
    // SQLite does not migrate on start unless the app sets `migrateOnStart: true`.
    const server = await buildNodeServer(root, { connection: { url } }, [], false, ensureThenSelect)
    expect(server.config.plugins).toBeUndefined()

    expect((await server.start()).stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 20231114221320_init.',
      '[vitehub] Database "default": applied 20231114221321_seed.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
    // A new process reads the ledger and finds nothing pending.
    expect((await server.start()).stdout.trim()).toBe(JSON.stringify([{ id: 7, name: "Ada" }]))
    expect(await readLedger(url)).toEqual([init.when, seed.when])
  })

  it("shares the run of the start plugin", { timeout: 60_000 }, async () => {
    const root = await createProject()
    await writeMigrations(root, [init, seed])
    const url = `file:${join(root, "data/app.sqlite")}`
    // Without the ledger, a run of its own would apply `init` again and fail on the existing table.
    const server = await buildNodeServer(root, { connection: { url }, migrateOnStart: true }, [], false, [
      'import { useDatabase as useStartDatabase } from "@vite-hub/database"',
      'await useStartDatabase("default").db.$client.execute("DROP TABLE __drizzle_migrations")',
      ...ensureThenSelect,
    ])
    expect(server.config.plugins).toEqual([join(root, ".vitehub/nitro/database/migrate-on-start.mjs")])
    expect((await server.start()).stdout.trim().split("\n")).toEqual([
      '[vitehub] Database "default": applied 20231114221320_init.',
      '[vitehub] Database "default": applied 20231114221321_seed.',
      JSON.stringify([{ id: 7, name: "Ada" }]),
    ])
  })

  it("forgets a failed run, so the next call applies the migrations", async () => {
    const root = await createProject()
    const client = createClient({ url: `file:${join(root, "retry.sqlite")}` })
    try {
      const gated = { dataLoss: [], hash: "gated", name: "20231114221320_gated", statements: ["INSERT INTO `gate` (`id`) VALUES (1)"], when: init.when }
      let loads = 0
      const context = {
        databases: { sqliteRetry: { db: drizzle({ client }) } },
        load: async () => {
          loads++
          return { allowDataLoss: false, databases: { sqliteRetry: { dialect: "sqlite" as const, migrations: [gated] } } }
        },
      }
      await expect(ensureDatabaseMigrations(context)).rejects.toThrow("no such table: gate")
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'")).rows).toEqual([])

      await client.execute("CREATE TABLE `gate` (`id` integer)")
      await ensureDatabaseMigrations(context, ["sqliteRetry"])
      await ensureDatabaseMigrations(context, ["sqliteRetry"])
      // The failed run and one new run: the third call shares the second.
      expect(loads).toBe(2)
      expect((await client.execute("SELECT count(*) FROM gate")).rows[0]?.[0]).toBe(1)
    }
    finally {
      client.close()
    }
  })

  it("applies a migration once when calls for Definitions on one SQLite file overlap", async () => {
    const root = await createProject()
    const url = `file:${join(root, "shared.sqlite")}`
    const clients = Array.from({ length: 4 }, () => createClient({ url }))
    try {
      await clients[0]!.execute("CREATE TABLE `events` (`message` text)")
      const once = { dataLoss: [], hash: "once", name: "20231114221320_once", statements: ["INSERT INTO `events` (`message`) VALUES ('once')"], when: init.when }
      const later = { dataLoss: [], hash: "later", name: "20231114221321_later", statements: ["INSERT INTO `events` (`message`) VALUES ('later')"], when: seed.when }
      const names = ["sharedFirst", "sharedSecond", "sharedThird", "sharedFourth"] as const
      const context = {
        databases: Object.fromEntries(names.map((name, index) => [name, { db: drizzle({ client: clients[index]! }) }])),
        load: async () => ({
          allowDataLoss: false,
          databases: Object.fromEntries(names.map(name => [name, { dialect: "sqlite" as const, migrations: name === "sharedFourth" ? [once, later] : [once] }])),
        }),
      }
      // Two named calls, then a named call that overlaps the call for every Database.
      await Promise.all([ensureDatabaseMigrations(context, ["sharedFirst"]), ensureDatabaseMigrations(context, ["sharedSecond"])])
      await Promise.all([ensureDatabaseMigrations(context, ["sharedThird"]), ensureDatabaseMigrations(context)])

      // The migration of the fourth Definition that the others do not have still applies.
      expect((await clients[0]!.execute("SELECT message FROM events ORDER BY rowid")).rows.map(row => row[0])).toEqual(["once", "later"])
      expect((await clients[0]!.execute("SELECT name FROM __drizzle_migrations ORDER BY id")).rows.map(row => row[0])).toEqual([once.name, later.name])
    }
    finally {
      for (const client of clients) client.close()
    }
  })

  it("ships the migrations to `ensureMigrations()` in a Vite build, and none to Cloudflare", async () => {
    const root = await createProject()
    await writeMigrations(root, [init])
    const load = async (config: Record<string, unknown>) => {
      const plugin = hubDatabaseVite({ migrateOnStart: { allowDataLoss: true } })
      await (plugin.configResolved as (config: unknown) => Promise<void>)({ plugins: [], root, ...config })
      // SAFETY: These are Vite hook handlers returned by hubDatabase.
      const id = (plugin.resolveId as { handler: (id: string) => string | undefined }).handler("#vitehub/database/migrations")
      // SAFETY: These are Vite hook handlers returned by hubDatabase.
      const code = await (plugin.load as { handler: (id: string) => Promise<string> | undefined }).handler(id!)
      return JSON.parse(code!.replace(/^export default /, ""))
    }
    const node = await load({ command: "build", nitro: { preset: "node-server" } })
    expect(node).toMatchObject({ allowDataLoss: true, databases: { default: { dialect: "sqlite", migrations: [{ name: init.tag, when: init.when }] } } })
    expect(await load({ command: "build", nitro: { preset: "cloudflare-module" } })).toEqual({ allowDataLoss: false, databases: {}, unsupported: "The build targets cloudflare." })
  })

  it("rejects a Database that is not configured, and a build that cannot migrate", async () => {
    const load = async () => ({ allowDataLoss: false, databases: {}, unsupported: "The build targets cloudflare." })
    await expect(ensureDatabaseMigrations({ databases: {}, load }, ["missing"])).rejects.toMatchObject({ code: "DATABASE_NOT_FOUND" })
    await expect(ensureDatabaseMigrations({ databases: { sqliteUnsupported: { db: {} } }, load })).rejects.toMatchObject({
      code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED",
      why: expect.stringContaining("The build targets cloudflare."),
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
    await writeFile(join(root, "server/databases/default.ts"), [
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
    await writeFile(join(root, "server/databases/default.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    await writeMigrations(root, [init])
    const configFor = async (preset: string) => {
      const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
      await hubDatabase({})(undefined, {
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
    await writeFile(join(root, "server/databases/default.ts"), [
      'import { defineDatabase } from "@vite-hub/database"',
      'import { integer, pgTable } from "drizzle-orm/pg-core"',
      'export default defineDatabase({ dialect: "postgresql", schema: { users: pgTable("users", { id: integer("id").primaryKey() }) } })',
    ].join("\n"))
    await writeMigrations(root, [init])
    const setup = async (options: { preset?: string }) => {
      const plugin = hubDatabaseVite({})
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
  interface FakeRow { created_at: number, hash: string, id: number, name?: string }

  /**
   * A postgres.js client that records each query and answers the lock, identity, and ledger reads. `ledger` undefined
   * has no table; rows without `name` make a Drizzle Kit 0.x table.
   */
  function fakeClient({ busy = 0, database = "app", events, fail, ledger, role = "app", schemas = ["public"], started = "1794260759.623267" }: { busy?: number, database?: string, events?: string[], fail?: string, ledger?: FakeRow[], role?: string, schemas?: string[], started?: string }) {
    const queries: Array<[string, unknown[] | undefined]> = []
    const named = ledger?.every(row => row.name !== undefined)
    const sql: PostgresMigrationSql = {
      unsafe: async (query, parameters) => {
        queries.push([query, parameters])
        events?.push(`${database}: ${query}`)
        if (query === fail) throw new Error("relation \"missing_table\" does not exist")
        if (query.startsWith("select pg_try_advisory_xact_lock")) return [{ locked: busy-- <= 0 }]
        if (query.startsWith("select current_database()")) return [{ database, role, schemas, started }]
        if (query.startsWith("select exists (select 1 from pg_namespace")) return [{ can_create: true, can_create_schema: true, can_use: true, database, found: Boolean(ledger), role }]
        if (query.startsWith("select to_regclass(")) return [{ ledger: ledger ? "drizzle.__drizzle_migrations" : null }]
        if (query.startsWith("select column_name")) return ledger ? ["id", "hash", "created_at", ...named ? ["name", "applied_at"] : []].map(column_name => ({ column_name })) : []
        if (query.startsWith("SELECT id, hash, created_at FROM")) return (ledger ?? []).map(({ created_at, hash, id }) => ({ created_at: String(created_at), hash, id }))
        if (query.startsWith("select id, hash, created_at, name")) return (ledger ?? []).map(row => ({ ...row, created_at: String(row.created_at), name: row.name ?? null }))
        return []
      },
    }
    return { client: { ...sql, begin: async <T>(run: (tx: PostgresMigrationSql) => Promise<T>) => await run(sql) }, queries }
  }

  it("takes the lock before it reads Drizzle's ledger, and applies each folder name that the ledger does not list", async () => {
    // `older` is older than the newest row but has no row: Drizzle 1.0 applies it.
    const { client, queries } = fakeClient({ ledger: [{ created_at: 2, hash: "hash-0002_newer", id: 1, name: "0002_newer" }] })
    const log: string[] = []
    const applied = await migratePostgres([{ client, database: { migrations: [migration("0001_older", 1, ["CREATE TABLE a (id int)"]), migration("0002_newer", 2, ["CREATE TABLE b (id int)"])], name: "default" } }], { log: message => log.push(message) })
    expect(applied).toEqual(["0001_older"])
    // One transaction holds the lock from the ledger read to the commit.
    expect(queries).toEqual([
      ["select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]],
      ["set local lock_timeout = '5s'", undefined],
      ["set local client_min_messages = warning", undefined],
      ["select exists (select 1 from pg_namespace where nspname = $1) as found, case when exists (select 1 from pg_namespace where nspname = $1) then has_schema_privilege($1, 'USAGE') end as can_use, case when exists (select 1 from pg_namespace where nspname = $1) then has_schema_privilege($1, 'CREATE') end as can_create, has_database_privilege(current_database(), 'CREATE') as can_create_schema, current_user as role, current_database() as database", ["drizzle"]],
      ["select to_regclass('\"drizzle\".\"__drizzle_migrations\"') as ledger", undefined],
      ["select column_name from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations'", undefined],
      [`select id, hash, created_at, name from ${ledgerTable}`, undefined],
      ["select format('%I.%I', nspname, relname) as name from pg_catalog.pg_class join pg_catalog.pg_namespace on relnamespace = pg_namespace.oid where nspname = current_schema() and relname = $1", ["_hub_migrations"]],
      ["CREATE TABLE a (id int)", undefined],
      [`insert into ${ledgerTable} ("hash", "created_at", "name") values ($1, $2, $3)`, ["hash-0001_older", 1, "0001_older"]],
    ])
    expect(log).toEqual(['[vitehub] Database "default": applied 0001_older.'])
  })

  it("creates Drizzle 1.0's ledger on an empty database", async () => {
    const { client, queries } = fakeClient({})
    await migratePostgres([{ client, database: { migrations: [], name: "default" } }], { log: () => {} })
    expect(queries.map(([query]) => query)).toContain(`CREATE TABLE IF NOT EXISTS ${ledgerTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamp with time zone DEFAULT now())`)
  })

  it("runs no DDL when the ledger already lists every migration", async () => {
    const { client, queries } = fakeClient({ fail: 'CREATE SCHEMA IF NOT EXISTS "drizzle"', ledger: [{ created_at: 1, hash: "hash-a0", id: 1, name: "a0" }] })
    await expect(migratePostgres([{ client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"])], name: "default" } }], { log: () => {} })).resolves.toEqual([])
    expect(queries.map(([query]) => query).filter(query => /^(CREATE|ALTER|UPDATE|insert)/i.test(query))).toEqual([])
  })

  it("upgrades a Drizzle Kit 0.x ledger under the lock, like Drizzle 1.0", async () => {
    // Drizzle Kit 0.x stored the journal `when` in milliseconds; Drizzle 1.0 matches the second.
    const { client, queries } = fakeClient({ ledger: [{ created_at: 1_700_000_000_417, hash: "hash-0x", id: 1 }] })
    await migratePostgres([{ client, database: { migrations: [migration("20231114221320_init", 1_700_000_000_000, ["CREATE TABLE a (id int)"])], name: "default" } }], { log: () => {} })
    expect(queries.slice(6, 10)).toEqual([
      [`SELECT id, hash, created_at FROM ${ledgerTable} ORDER BY id ASC`, undefined],
      [`ALTER TABLE ${ledgerTable} ADD COLUMN IF NOT EXISTS "name" text`, undefined],
      [`ALTER TABLE ${ledgerTable} ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone DEFAULT now()`, undefined],
      [`UPDATE ${ledgerTable} SET "name" = $1, "applied_at" = NULL WHERE "id" = $2`, ["20231114221320_init", 1]],
    ])
  })

  it("refuses a Drizzle Kit 0.x ledger row that matches no migration folder", async () => {
    const { client, queries } = fakeClient({ ledger: [{ created_at: 5_000, hash: "hash-gone", id: 3 }] })
    await expect(migratePostgres([{ client, database: { migrations: [migration("20231114221320_init", 1_700_000_000_000, ["CREATE TABLE a (id int)"])], name: "default" } }], { log: () => {} }))
      .rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED", why: expect.stringContaining("(id 3) that match no migration folder") })
    expect(queries.map(([query]) => query)).not.toContain("CREATE TABLE a (id int)")
  })

  it("says that it waits when another process holds the lock, and tries again instead of blocking", async () => {
    const { client, queries } = fakeClient({ busy: 2 })
    const log: string[] = []
    await migratePostgres([{ client, database: { migrations: [], name: "default" } }], { log: message => log.push(message) })
    expect(queries.slice(0, 4)).toEqual([
      ["select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]],
      ["select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]],
      ["select pg_try_advisory_xact_lock(hashtext($1)) as locked", [postgresMigrationLock]],
      ["set local lock_timeout = '5s'", undefined],
    ])
    expect(queries.map(([query]) => query)).not.toContain("select pg_advisory_xact_lock(hashtext($1))")
    expect(log).toEqual(['[vitehub] Database "default": another process is applying migrations. Waiting for it to finish.'])
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

  it("migrates Definitions on one Postgres database together, including an older migration of the second", async () => {
    const ledger: FakeRow[] = [{ created_at: 1, hash: "hash-a0", id: 1, name: "a0" }, { created_at: 3, hash: "hash-a1", id: 2, name: "a1" }]
    const first = fakeClient({ ledger })
    const second = fakeClient({ ledger })
    const log: string[] = []
    await migratePostgres([
      { client: first.client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"]), migration("a1", 3, ["CREATE TABLE a1 (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "second": applied b0.'])
    // One transaction on the first client runs every migration of the shared database.
    expect(first.queries.map(([query]) => query)).toContain("CREATE TABLE b (id int)")
    expect(second.queries.map(([query]) => query)).toEqual([expect.stringMatching(/^select current_database\(\)/)])
  })

  it("refuses one folder name with different SQL on a shared database", async () => {
    const first = fakeClient({})
    const second = fakeClient({})
    await expect(migratePostgres([
      { client: first.client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [{ ...migration("a0", 1, ["CREATE TABLE b (id int)"]), hash: "other" }], name: "second" } },
    ], { log: () => {} })).rejects.toThrow("It and the Database \"first\" share one Postgres database, and both have the migration \"a0\" with different SQL.")
  })

  it.each([
    { role: "other" },
    { schemas: ["other", "public"] },
    { schemas: ["second", "first"] },
  ])("refuses incompatible sessions on one database before taking any locks: %j", async (context) => {
    const first = fakeClient({ schemas: ["first", "second"] })
    const second = fakeClient({ schemas: ["first", "second"], ...context })
    await expect(migratePostgres([
      { client: first.client, database: { migrations: [migration("a0", 1, ["CREATE TABLE a (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: () => {} })).rejects.toMatchObject({ code: "DATABASE_MIGRATE_ON_START_UNSUPPORTED", why: expect.stringContaining("different roles or schema search paths") })
    expect([...first.queries, ...second.queries].some(([query]) => query.includes("advisory") || /^(CREATE|ALTER|insert)/i.test(query))).toBe(false)
  })

  it("keeps Definitions on different Postgres databases apart, and locks them in key order", async () => {
    const events: string[] = []
    const first = fakeClient({ database: "zeta", events, ledger: [{ created_at: 3, hash: "hash-a1", id: 1, name: "a1" }] })
    const second = fakeClient({ database: "alpha", events })
    const log: string[] = []
    await migratePostgres([
      { client: first.client, database: { migrations: [migration("a1", 3, ["CREATE TABLE a1 (id int)"])], name: "first" } },
      { client: second.client, database: { migrations: [migration("b0", 2, ["CREATE TABLE b (id int)"])], name: "second" } },
    ], { log: message => log.push(message) })
    expect(log).toEqual(['[vitehub] Database "second": applied b0.'])
    // "alpha" sorts first, so its lock comes before the lock of "zeta", whatever the order of the Definitions.
    expect(events.filter(event => event.includes("pg_try_advisory_xact_lock")).map(event => event.split(":")[0])).toEqual(["alpha", "zeta"])
  })

  it("names a database by what every session reads the same: not the address, the TimeZone, or the role", async () => {
    const queries: string[] = []
    const key = await readPostgresDatabaseKey({ unsafe: async (query) => {
      queries.push(query)
      return [{ database: "app", started: "1794260759.623267" }]
    } })
    expect(key).toBe(JSON.stringify(["app", "1794260759.623267"]))
    expect(queries).toEqual(["select current_database() as database, extract(epoch from pg_postmaster_start_time())::text as started, current_user as role, current_schemas(false) as schemas"])
  })
})
