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
    await runWithDatabaseRequestStats({ req: { context: { log: { set } } } }, async () => {
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
