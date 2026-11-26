import { spawn as spawnProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { defineRelations, sql } from "drizzle-orm"
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { readMigrationPlan } from "../src/internal/migration-plan.ts"
import { migrateOnStart } from "../src/runtime/migrate-on-start.ts"
import { defineDatabase } from "../src/definition.ts"
import { hubDatabase as hubDatabaseNuxt } from "../src/nuxt.ts"
import { createDevPostgresDatabase } from "../src/runtime/pglite.ts"
import { postgresEnvNames } from "../src/runtime/postgres-env.ts"
import { runWithDatabaseRequestStats } from "../src/runtime/request-stats.ts"
import { hubDatabase } from "../src/vite.ts"

const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
})

const roots: string[] = []

// The package has drizzle-kit, drizzle-orm, and PGlite in its dependencies, like an app that uses PGlite.
async function createProject(definition: string[]) {
  const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
  roots.push(root)
  const file = join(root, "server/databases/default.ts")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { pgTable, serial, text } from 'drizzle-orm/pg-core'",
    "export default defineDatabase({",
    "  dialect: 'postgresql',",
    ...definition,
    "  schema: { notes: pgTable('notes', { id: serial('id').primaryKey(), title: text('title').notNull() }) },",
    "})",
    "",
  ].join("\n"))
  return root
}

/** An environment with no Postgres server: no `DATABASE_URL` and no PG* variables. */
function serverlessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ["DATABASE_URL", ...postgresEnvNames]) delete env[name]
  return env
}

function spawn(command: string, args: string[], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("error", reject)
    child.on("close", exitCode => resolve({ exitCode }))
  })
}

type Hook<T> = { handler: (...args: never[]) => T } | ((...args: never[]) => T)

function callHook<T>(hook: unknown, ...args: unknown[]): T {
  // SAFETY: The tests call Vite hooks that hubDatabase() returns, with the arguments Vite passes.
  const value = hook as Hook<T>
  return (typeof value === "function" ? value : value.handler)(...(args as never[]))
}

/** Runs `hubDatabase()` like `vite dev` or `vite build`, and returns the plugin with its CLI. */
async function startVite(root: string, command: "build" | "serve") {
  const plugin = hubDatabase()
  await callHook(plugin.configResolved, { command, plugins: [], root })
  return plugin
}

async function runCli(plugin: ReturnType<typeof hubDatabase>, root: string, feature: "generate" | "migrate", args: string[] = []) {
  const cli = await plugin.vitehub!.cli!()
  const command = cli!.namespaces[0]!.features.find(candidate => candidate.name === feature)!
  const stdout = { write: vi.fn() }
  const stderr = { write: vi.fn() }
  const exitCode = await command.run(args, { env: serverlessEnv(), rootDir: root, spawn, stderr, stdout } as never)
  const text = (write: ReturnType<typeof vi.fn>) => write.mock.calls.map(([chunk]) => String(chunk)).join("")
  return { exitCode, stderr: text(stderr.write), stdout: text(stdout.write) }
}

/** Writes the `#vitehub/database/databases` module that `vite dev` loads, and imports it. */
async function importDevDatabases(plugin: ReturnType<typeof hubDatabase>, root: string) {
  const id = await callHook<string>(plugin.resolveId, "#vitehub/database/databases")
  const code = await callHook<string>(plugin.load, id)
  const file = join(root, ".vitehub/databases.dev.mjs")
  await writeFile(file, code)
  const module = await import(pathToFileURL(file).href) as { default: Record<string, { db: Record<string, unknown> }> }
  return { code, db: module.default.default!.db }
}

beforeEach(() => {
  for (const name of ["DATABASE_URL", ...postgresEnvNames]) vi.stubEnv(name, "")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("a Postgres Database without a server in development", () => {
  it("generates and applies migrations to PGlite, and `vite dev` queries the same folder", async () => {
    const root = await createProject(["  connection: { url: process.env.DATABASE_URL },"])
    const plugin = await startVite(root, "serve")

    await expect(runCli(plugin, root, "generate", ["--name", "init"])).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    const dryRun = await runCli(plugin, root, "migrate", ["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain("[vitehub] Database \"default\" (PGlite .vitehub/data/database/pglite): 1 pending migration.")
    expect(dryRun.stdout).toContain("CREATE TABLE \"notes\"")
    // The check does not create the folder. `vitehub database migrate` does.
    expect(existsSync(join(root, ".vitehub/data/database/pglite"))).toBe(false)
    await expect(runCli(plugin, root, "migrate")).resolves.toMatchObject({ exitCode: 0, stderr: "" })

    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const { code, db } = await importDevDatabases(plugin, root)
    expect(code).toContain("await createDevPostgresDatabase(")
    // The module loads PGlite, but opens the folder only on the first query.
    expect(info).not.toHaveBeenCalled()
    const database = db as unknown as ReturnType<typeof import("drizzle-orm/pglite").drizzle>
    await database.insert(notes).values({ title: "first" })
    expect(await database.select().from(notes)).toEqual([{ id: 1, title: "first" }])
    expect(info).toHaveBeenCalledWith(`[vitehub] Database "default" runs on PGlite in ${join(root, ".vitehub/data/database/pglite")}, because it has no \`connection.url\` or PG* variables.`)
    await database.$client.close()

    const done = await runCli(plugin, root, "migrate", ["--dry-run"])
    expect(done).toMatchObject({ exitCode: 0, stderr: "" })
    expect(done.stdout).toContain("[vitehub] Database \"default\" (PGlite .vitehub/data/database/pglite): no pending migrations.")
  }, 120_000)

  it.each([
    ["a URL", { url: "postgres://localhost:5432/app" }, {}],
    ["PG* variables", {}, { PGHOST: "localhost" }],
  ])("connects with postgres.js and does not open PGlite for %s", async (_, connection, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
    roots.push(root)
    const db = await createDevPostgresDatabase({ connection, dialect: "postgresql", name: "default", relations: defineRelations({ notes }), schema: { notes } }, { binding: "HYPERDRIVE" }, {
      dataDir: join(root, "pglite"),
      migrationsDir: join(root, "migrations"),
    })
    // postgres.js connects on the first query, so reading the client does not need a server.
    expect(Reflect.get(db, "$client")).toEqual(expect.any(Function))
    expect(existsSync(join(root, "pglite"))).toBe(false)
  })

  it("runs on PGlite with `driver: \"pglite\"`, even with a URL", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
    roots.push(root)
    vi.spyOn(console, "info").mockImplementation(() => {})
    const db = await createDevPostgresDatabase({ connection: { url: "postgres://localhost:5432/app" }, dialect: "postgresql", driver: "pglite", name: "default", relations: defineRelations({ notes }), schema: { notes } }, { binding: "HYPERDRIVE" }, {
      dataDir: join(root, "pglite"),
      migrationsDir: join(root, "migrations"),
    })
    expect(await db.execute(sql`select 1 as one`)).toMatchObject({ rows: [{ one: 1 }] })
    expect(existsSync(join(root, "pglite/PG_VERSION"))).toBe(true)
    await Reflect.get(db, "$client").close()
  }, 60_000)

  it("counts the Drizzle queries on PGlite in the request stats, also in transactions and when they fail", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
    roots.push(root)
    vi.spyOn(console, "info").mockImplementation(() => {})
    const db = await createDevPostgresDatabase({ dialect: "postgresql", name: "default", relations: defineRelations({ notes }), schema: { notes } }, { binding: "HYPERDRIVE" }, {
      dataDir: join(root, "pglite"),
      migrationsDir: join(root, "migrations"),
    })
    const client = Reflect.get(db, "$client") as { close: () => Promise<void>, query: (query: string) => Promise<unknown> }
    const set = vi.fn()
    await runWithDatabaseRequestStats({ req: { context: { log: { set, warn: vi.fn(), error: vi.fn() } } } }, async () => {
      await db.execute(sql`create table notes (id serial primary key, title text not null)`)
      await db.transaction(async (tx) => {
        await tx.insert(notes).values({ title: "first" })
        await tx.transaction(async nested => nested.select().from(notes))
      })
      await expect(db.execute(sql`select * from missing_table`)).rejects.toThrow()
      // `db.$client` stays PGlite's own client, so a direct call is not counted.
      await client.query("select 1")
    })

    // create, insert, savepoint, select, release savepoint, and the failed select.
    expect(set).toHaveBeenCalledExactlyOnceWith({ database: { calls: 6, ms: expect.any(Number), maxConcurrent: 1 } })
    await client.close()
  }, 60_000)

  it("keeps one PGlite client per folder when `vite dev` evaluates the databases module again", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
    roots.push(root)
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const options = { dataDir: join(root, "pglite"), migrationsDir: join(root, "migrations") }
    const definition = { dialect: "postgresql" as const, name: "default", relations: defineRelations({ notes }), schema: { notes } }
    // A Definition change gives a new module, and so a new database, in the same process.
    const before = await createDevPostgresDatabase(definition, { binding: "HYPERDRIVE" }, options)
    await before.execute(sql`create table notes (id serial primary key, title text not null)`)
    await before.insert(notes).values({ title: "before the change" })
    const after = await createDevPostgresDatabase(definition, { binding: "HYPERDRIVE" }, options)

    expect(await after.select().from(notes)).toEqual([{ id: 1, title: "before the change" }])
    expect(Reflect.get(after, "$client")).toBe(Reflect.get(before, "$client"))
    expect(info).toHaveBeenCalledTimes(1)
    await Reflect.get(after, "$client").close()
  }, 60_000)

  it.each([false, true])("queries Definition relations on PGlite (app test mode: %s)", async (inMemory) => {
    const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
    roots.push(root)
    vi.spyOn(console, "info").mockImplementation(() => {})
    const authors = pgTable("authors", { id: serial("id").primaryKey(), name: text("name").notNull() })
    const books = pgTable("books", { id: serial("id").primaryKey(), authorId: integer("author_id").notNull() })
    const schema = { authors, books }
    const definition = defineDatabase({
      dialect: "postgresql",
      relations: defineRelations(schema, r => ({ books: { author: r.one.authors({ from: r.books.authorId, to: r.authors.id }) } })),
      schema,
    })
    const mode = inMemory ? enableViteHubTestMode({ root }) : undefined
    const db = await createDevPostgresDatabase(definition, { binding: "HYPERDRIVE" }, {
      dataDir: join(root, "pglite"),
      migrationsDir: join(root, "migrations"),
    })
    try {
      await db.execute(sql`create table authors (id serial primary key, name text not null)`)
      await db.execute(sql`create table books (id serial primary key, author_id integer not null)`)
      await db.insert(authors).values({ name: "Ada" })
      await db.insert(books).values({ authorId: 1 })

      expect(await db.query.books.findMany({ with: { author: true } })).toEqual([
        { id: 1, authorId: 1, author: { id: 1, name: "Ada" } },
      ])
      expect(existsSync(join(root, "pglite"))).toBe(!inMemory)
    }
    finally {
      if (mode) {
        await mode.reset()
        Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
      }
      else await Reflect.get(db, "$client").close()
    }
  }, 60_000)

  it("names the fix when `vitehub database migrate` cannot load PGlite", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-pglite-"))
    roots.push(root)
    // pnpm puts the workspace packages on NODE_PATH, so give the project a PGlite package that does not load.
    await mkdir(join(root, "node_modules/@electric-sql/pglite"), { recursive: true })
    await writeFile(join(root, "node_modules/@electric-sql/pglite/package.json"), "{\"name\":\"@electric-sql/pglite\",\"main\":\"missing.js\"}")
    await mkdir(join(root, "migrations/20260101000000_notes"), { recursive: true })
    await writeFile(join(root, "migrations/20260101000000_notes/migration.sql"), "CREATE TABLE \"notes\" (\"id\" serial PRIMARY KEY NOT NULL);\n")
    const database = { dialect: "postgresql" as const, generatedSchemaFile: "", migrationsDir: join(root, "migrations"), mode: "default" as const, name: "default", orm: "drizzle" as const }

    const [error] = await readMigrationPlan(database, { env: serverlessEnv(), projectRoot: root })

    expect(error).toMatchObject({
      code: "DATABASE_MIGRATION_CHECK_FAILED",
      message: expect.stringContaining("Set `connection.url` to migrate a Postgres server, or install PGlite with `pnpm add -D @electric-sql/pglite`."),
    })
    // The check fails before Drizzle Kit runs, and creates no folder.
    expect(existsSync(join(root, ".vitehub"))).toBe(false)
  })

  it("names the fix on the first query when `vite dev` cannot load PGlite", async () => {
    vi.resetModules()
    vi.doMock("@electric-sql/pglite", () => {
      throw new Error("Cannot find package '@electric-sql/pglite'")
    })
    try {
      const { createDevPostgresDatabase: createDatabase } = await import("../src/runtime/pglite.ts")
      const root = await mkdtemp(join(import.meta.dirname, ".pglite-"))
      roots.push(root)
      const options = { dataDir: join(root, "pglite"), migrationsDir: join(root, "migrations") }
      // The module still loads, so an app that does not query this Database keeps working.
      const db = await createDatabase({ dialect: "postgresql", name: "default", relations: defineRelations({ notes }), schema: { notes } }, { binding: "HYPERDRIVE" }, options)

      expect(() => db.select().from(notes)).toThrow(expect.objectContaining({
        code: "DATABASE_PGLITE_NOT_INSTALLED",
        fix: expect.stringContaining("pnpm add -D @electric-sql/pglite"),
        message: expect.stringContaining("has no `connection.url` or PG* variables, so development runs it on PGlite"),
      }))
      expect(existsSync(join(root, "pglite"))).toBe(false)
    }
    finally {
      vi.doUnmock("@electric-sql/pglite")
      vi.resetModules()
    }
  })
})

describe("migrations on start on PGlite", () => {
  it("applies the migrations of each PGlite client to that client, with Drizzle's ledger rows", async () => {
    const { PGlite } = await import("@electric-sql/pglite")
    const { drizzle } = await import("drizzle-orm/pglite")
    const clients = [new PGlite("memory://"), new PGlite("memory://")]
    const migration = (name: string, when: number) => ({ dataLoss: [], hash: name, name, statements: [`CREATE TABLE "${name}" ("id" serial PRIMARY KEY)`], when })
    const log = vi.fn()
    try {
      await migrateOnStart([
        { db: drizzle({ client: clients[0]! }), dialect: "postgresql", migrations: [migration("one", 1)], name: "one" },
        { db: drizzle({ client: clients[1]! }), dialect: "postgresql", migrations: [migration("two", 2)], name: "two" },
      ], { log })

      for (const [index, name] of ["one", "two"].entries()) {
        const { rows } = await clients[index]!.query("select hash, created_at::text, name from drizzle.__drizzle_migrations")
        expect(rows).toEqual([{ created_at: String(index + 1), hash: name, name }])
        await expect(clients[index]!.query(`select count(*)::int as count from "${name}"`)).resolves.toMatchObject({ rows: [{ count: 0 }] })
      }
      expect(log.mock.calls.map(([message]) => message).sort()).toEqual(["[vitehub] Database \"one\": applied one.", "[vitehub] Database \"two\": applied two."])
    }
    finally {
      await Promise.all(clients.map(client => client.close()))
    }
  }, 60_000)
})

describe("NuxtHub's _hub_migrations on PGlite", () => {
  const nuxtHubHistory = [
    "CREATE TABLE \"notes\" (\"id\" serial PRIMARY KEY, \"title\" text NOT NULL);",
    "CREATE TABLE _hub_migrations (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);",
    "INSERT INTO _hub_migrations (name) VALUES ('0000_init');",
  ].join("\n")

  it.each(["preserved", "ambiguous", "normalized collision", "fallback", "read-only", "missing drizzle schema"])("handles %s history without skipping pending SQL", async (scenario) => {
    const { PGlite } = await import("@electric-sql/pglite")
    const { drizzle } = await import("drizzle-orm/pglite")
    const client = new PGlite("memory://")
    const makeDatabase = (name: string, tag: string, statement: string) => ({
      db: drizzle({ client }), dialect: "postgresql" as const,
      migrations: [{ dataLoss: [], hash: `hash-${tag}`, name: tag, statements: [statement], when: 1 }], name,
    })
    const options = { log: () => {} }
    try {
      await client.exec(nuxtHubHistory)
      if (scenario === "preserved") {
        await client.exec("update _hub_migrations set name = '0001_seed'")
        const database = makeDatabase("default", "20260101000000_0001_seed", "create table notes (id int)")
        database.migrations.push(...makeDatabase("default", "20260102000000_seed", "create table next_seed (id int)").migrations)
        await migrateOnStart([database], options)
        expect((await client.query("select to_regclass('next_seed')::text as name")).rows).toEqual([{ name: "next_seed" }])
      }
      else if (scenario === "ambiguous" || scenario === "normalized collision") {
        const firstTag = scenario === "ambiguous" ? "20260101000000_init" : "20260101000000_0000_init"
        const secondTag = scenario === "ambiguous" ? "20260102000000_init" : "20260102000000_0000_init.postgresql"
        const first = makeDatabase("first", firstTag, "create table notes (id int)")
        const second = makeDatabase("second", secondTag, "create table widgets (id int)")
        await expect(migrateOnStart([first, second], options)).rejects.toMatchObject({ code: "DATABASE_MIGRATION_CHECK_FAILED" })
        expect((await client.query("select to_regclass('drizzle.__drizzle_migrations') as ledger")).rows).toEqual([{ ledger: null }])
      }
      else if (scenario === "fallback") {
        await client.exec("create schema app; set search_path to app, public")
        await migrateOnStart([makeDatabase("default", "20260101000000_init", "create table widgets (id int)")], options)
        expect((await client.query("select to_regclass('app.widgets')::text as name")).rows).toEqual([{ name: "widgets" }])
      }
      else if (scenario === "missing drizzle schema") {
        await client.exec("set search_path to drizzle, public")
        await migrateOnStart([makeDatabase("default", "20260101000000_init", "create table notes (id int)")], options)
        expect((await client.query("select name from drizzle.__drizzle_migrations")).rows).toEqual([{ name: "20260101000000_init" }])
        expect((await client.query("select to_regclass('drizzle.notes') as name")).rows).toEqual([{ name: null }])
      }
      else {
        const database = makeDatabase("default", "20260101000000_init", "create table notes (id int)")
        await migrateOnStart([database], options)
        await client.exec("create role app; grant usage on schema drizzle to app; grant select on drizzle.__drizzle_migrations to app; set role app")
        await migrateOnStart([database], options)
        const pending = makeDatabase("default", "20260102000000_more", "create table more (id int)")
        await expect(migrateOnStart([pending], options)).rejects.toMatchObject({ code: "42501" })
      }
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it.each([
    ["20260101000000_bootstrap", "bootstrap"],
    ["20260101000000_0001_create-users.postgresql", "0001_create-users"],
  ])("does not replay the PGlite folder %s on start", async (tag, name) => {
    const { PGlite } = await import("@electric-sql/pglite")
    const { drizzle } = await import("drizzle-orm/pglite")
    const client = new PGlite("memory://")
    const log = vi.fn()
    try {
      await client.exec(nuxtHubHistory)
      await client.query("update _hub_migrations set name = $1", [name])
      await migrateOnStart([{ db: drizzle({ client }), dialect: "postgresql", migrations: [
        { dataLoss: [], hash: `hash-${tag}`, name: tag, statements: ["CREATE TABLE \"notes\" (\"id\" serial PRIMARY KEY, \"title\" text NOT NULL);"], when: 1_767_225_600_000 },
      ], name: "default" }], { log })

      expect(log.mock.calls.map(([message]) => message)).toEqual([`[vitehub] Database "default": recorded ${tag} as applied, as _hub_migrations lists it.`])
      expect((await client.query("select name from drizzle.__drizzle_migrations")).rows).toEqual([{ name: tag }])
    }
    finally {
      await client.close()
    }
  })

  it("adopts on PGlite", async () => {
    const { PGlite } = await import("@electric-sql/pglite")
    const { drizzle } = await import("drizzle-orm/pglite")
    const client = new PGlite("memory://")
    const migration = (name: string, when: number, statement: string) => ({ dataLoss: [], hash: `hash-${name}`, name, statements: [statement], when })
    const log = vi.fn()
    try {
      await client.exec(nuxtHubHistory)
      await migrateOnStart([{ db: drizzle({ client }), dialect: "postgresql", migrations: [
        migration("20260101000000_init", 1_767_225_600_000, "CREATE TABLE \"notes\" (\"id\" serial PRIMARY KEY, \"title\" text NOT NULL);"),
        migration("20260102000000_add_body", 1_767_312_000_000, "ALTER TABLE \"notes\" ADD COLUMN \"body\" text;"),
      ], name: "default" }], { log })

      expect(log.mock.calls.map(([message]) => message)).toEqual([
        "[vitehub] Database \"default\": recorded 20260101000000_init as applied, as _hub_migrations lists it.",
        "[vitehub] Database \"default\": applied 20260102000000_add_body.",
      ])
      const { rows } = await client.query("select hash, created_at::text, name from drizzle.__drizzle_migrations order by id")
      expect(rows).toEqual([
        { created_at: "1767225600000", hash: "hash-20260101000000_init", name: "20260101000000_init" },
        { created_at: "1767312000000", hash: "hash-20260102000000_add_body", name: "20260102000000_add_body" },
      ])
    }
    finally {
      await client.close()
    }
  })

  it.each([
    ["20260101000000_init", "0000_init"],
    ["20260101000000_bootstrap", "bootstrap"],
    ["20260101000000_0001_create-users.postgresql", "0001_create-users"],
  ])("previews and adopts the PGlite folder %s", async (tag, name) => {
    const root = await createProject([])
    const migrations = join(root, "server/databases/default/migrations")
    await mkdir(join(migrations, tag), { recursive: true })
    await writeFile(join(migrations, tag, "migration.sql"), "CREATE TABLE \"notes\" (\"id\" serial PRIMARY KEY, \"title\" text NOT NULL);\n")
    await mkdir(join(migrations, "20260102000000_add_body"), { recursive: true })
    await writeFile(join(migrations, "20260102000000_add_body/migration.sql"), "ALTER TABLE \"notes\" ADD COLUMN \"body\" text;\n")
    const { PGlite } = await import("@electric-sql/pglite")
    await mkdir(join(root, ".vitehub/data/database"), { recursive: true })
    const seeded = new PGlite(join(root, ".vitehub/data/database/pglite"))
    await seeded.exec(nuxtHubHistory)
    await seeded.query("update _hub_migrations set name = $1", [name])
    await seeded.close()
    const plugin = await startVite(root, "serve")

    const dryRun = await runCli(plugin, root, "migrate", ["--dry-run"])
    expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" })
    expect(dryRun.stdout).toContain(`1 pending migration.\n  Applied before, as _hub_migrations lists: ${tag}\n`)
    const applied = await runCli(plugin, root, "migrate")
    expect(applied).toMatchObject({ exitCode: 0, stderr: "" })
    expect(applied.stdout).toContain(`recorded ${tag} as applied, as _hub_migrations lists it.`)
    expect(applied.stdout).toContain("applied 20260102000000_add_body.")
    const done = await runCli(plugin, root, "migrate", ["--dry-run"])
    expect(done.stdout).toContain("(PGlite .vitehub/data/database/pglite): no pending migrations.\n")
  }, 60_000)

  it("reports a migration check failure when opening and closing the PGlite store both fail", async () => {
    const root = await createProject([])
    const migration = join(root, "server/databases/default/migrations/20260101000000_init")
    await mkdir(migration, { recursive: true })
    await writeFile(join(migration, "migration.sql"), "CREATE TABLE notes (id int);")
    const path = join(root, ".vitehub/data/database/pglite")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "not a directory")
    const plugin = await startVite(root, "serve")

    const dryRun = await runCli(plugin, root, "migrate", ["--dry-run"])
    expect(dryRun.exitCode).toBe(1)
    expect(dryRun.stderr).toContain("DATABASE_MIGRATION_CHECK_FAILED")
    expect(dryRun.stderr).toContain("ViteHub cannot read the pending migrations of the database \"default\".")
  }, 30_000)
})

describe("a Postgres Database on PGlite in app tests", () => {
  const root = join(import.meta.dirname, ".pglite-test-mode")

  afterAll(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { force: true, recursive: true })
  })

  it("uses an in-memory PGlite with the migrations, empty after each reset", async () => {
    const migrations = join(root, "server/databases/default/migrations")
    await mkdir(join(migrations, "20260101000000_notes"), { recursive: true })
    await writeFile(join(migrations, "20260101000000_notes/migration.sql"), "CREATE TABLE \"notes\" (\n\t\"id\" serial PRIMARY KEY NOT NULL,\n\t\"title\" text NOT NULL\n);\n")
    const db = await createDevPostgresDatabase({ dialect: "postgresql", name: "default", relations: defineRelations({ notes }), schema: { notes } }, { binding: "HYPERDRIVE" }, {
      dataDir: join(root, ".vitehub/data/database/pglite"),
      migrationsDir: migrations,
    })
    const mode = enableViteHubTestMode({ root })

    await db.insert(notes).values({ title: "first" })
    expect(await db.select().from(notes)).toEqual([{ id: 1, title: "first" }])

    await mode.reset()

    expect(await db.select().from(notes)).toEqual([])
    // Test mode never opens the development folder.
    expect(existsSync(join(root, ".vitehub/data/database/pglite"))).toBe(false)
  }, 60_000)
})

describe("PGlite in a production build", () => {
  it("fails a Vite build of a Database with `driver: \"pglite\"`, and names the fix", async () => {
    const root = await createProject(["  driver: 'pglite',"])
    const plugin = await startVite(root, "build")

    expect(() => callHook(plugin.buildStart)).toThrow(expect.objectContaining({
      code: "DATABASE_PGLITE_IN_BUILD",
      fix: expect.stringContaining("set `connection.url` to your Postgres server"),
    }))
  })

  it("fails a Nuxt build of a Database with `driver: \"pglite\"`", async () => {
    const root = await createProject(["  driver: 'pglite',"])
    // Nuxt takes the project root from the nearest package.json.
    await writeFile(join(root, "package.json"), "{\"private\":true,\"type\":\"module\"}")
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    await hubDatabaseNuxt()(undefined, {
      hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
        if (event === "nitro:config") hooks.push(callback)
      },
      options: { buildDir: join(root, ".nuxt"), dev: false, nitro: { preset: "node-server" }, rootDir: root, vite: {} },
    })

    await expect((async () => { for (const hook of hooks) await hook({ alias: {} }) })()).rejects.toMatchObject({ code: "DATABASE_PGLITE_IN_BUILD" })
  })

  it("keeps PGlite out of the production module of a Database without a URL", async () => {
    const root = await createProject([])
    const plugin = await startVite(root, "build")

    expect(() => callHook(plugin.buildStart)).not.toThrow()
    const code = await callHook<string>(plugin.load, await callHook<string>(plugin.resolveId, "#vitehub/database/databases"))
    expect(code).toContain("createPostgresDatabase(")
    expect(code).not.toContain("createDevPostgresDatabase")
    expect(code).not.toContain("runtime/pglite")
  })
})
