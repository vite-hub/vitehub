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
import { hubDatabase } from "../src/nuxt.ts"
import { ensureDatabaseMigrations, migrateOnStart, migratePostgres, postgresMigrationLock, readPostgresDatabaseKey } from "../src/runtime/migrate-on-start.ts"
import { hubDatabase as hubDatabaseVite } from "../src/vite.ts"

import type { PostgresMigrationSql } from "../src/runtime/migrate-on-start.ts"
import type { DatabaseNuxtIntegrationOptions, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

const init = { sql: "CREATE TABLE `users` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL\n);\n--> statement-breakpoint\nCREATE TABLE `legacy` (`id` integer);\n", tag: "20231114221320_init", when: 1_700_000_000_000 }
const seed = { sql: "INSERT INTO `users` (`id`, `name`) VALUES (7, 'Ada');", tag: "20231114221321_seed", when: 1_700_000_001_000 }
const dropLegacy = { sql: "DROP TABLE `legacy`;", tag: "20231114221322_drop_legacy", when: 1_700_000_002_000 }

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
    expect(await setup({ dev: true, preset: "node-server" })).toBeUndefined()
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
  function fakeClient({ database = "app", events, fail, ledger, locked = true, role = "app", schemas = ["public"], started = "1794260759.623267" }: { database?: string, events?: string[], fail?: string, ledger?: FakeRow[], locked?: boolean, role?: string, schemas?: string[], started?: string }) {
    const queries: Array<[string, unknown[] | undefined]> = []
    const named = ledger?.every(row => row.name !== undefined)
    const sql: PostgresMigrationSql = {
      unsafe: async (query, parameters) => {
        queries.push([query, parameters])
        events?.push(`${database}: ${query}`)
        if (query === fail) throw new Error("relation \"missing_table\" does not exist")
        if (query.startsWith("select pg_try_advisory_xact_lock")) return [{ locked }]
        if (query.startsWith("select current_database()")) return [{ database, role, schemas, started }]
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
      ["select to_regclass('drizzle.__drizzle_migrations') as ledger", undefined],
      ["select column_name from information_schema.columns where table_schema = 'drizzle' and table_name = '__drizzle_migrations'", undefined],
      [`select id, hash, created_at, name from ${ledgerTable}`, undefined],
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
    expect(queries.slice(5, 9)).toEqual([
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

  it("says that it waits when another process holds the lock", async () => {
    const { client, queries } = fakeClient({ locked: false })
    const log: string[] = []
    await migratePostgres([{ client, database: { migrations: [], name: "default" } }], { log: message => log.push(message) })
    expect(queries[1]).toEqual(["select pg_advisory_xact_lock(hashtext($1))", [postgresMigrationLock]])
    expect(queries[2]).toEqual(["set local lock_timeout = '5s'", undefined])
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
