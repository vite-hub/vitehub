// The real cases run only with a Postgres server, for example:
// docker run -d --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:54329/postgres vitest run test/node-postgres.test.ts
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { clearActiveCloudflareEnv, runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineDatabase } from "../src/definition.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

const fake = vi.hoisted(() => ({ enabled: true, pools: [] as Array<{ end: ReturnType<typeof vi.fn>, listeners: Record<string, (...args: unknown[]) => void>, options: Record<string, unknown> }> }))
const postgresJs = vi.hoisted(() => ({ loaded: false }))

// The fake Pool records its options. The real tests below use the real `pg`.
vi.mock("pg", async (importOriginal) => {
  const real = await importOriginal<typeof import("pg")>()
  class Pool extends real.default.Pool {
    constructor(options: Record<string, unknown>) {
      super(options)
      if (!fake.enabled) return
      const listeners: Record<string, (...args: unknown[]) => void> = {}
      const on = this.on.bind(this)
      this.on = ((event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = listener
        return on(event as "error", listener)
      }) as typeof this.on
      const end = vi.fn(async () => {})
      this.end = end as unknown as typeof this.end
      fake.pools.push({ end, listeners, options })
    }
  }
  return { ...real, default: { ...real.default, Pool } }
})

vi.mock("postgres", async (importOriginal) => {
  postgresJs.loaded = true
  return await importOriginal()
})

const notes = pgTable("notes", { id: integer("id").primaryKey(), title: text("title").notNull() })
const definition = defineDatabase({ dialect: "postgresql", driver: "node-postgres", schema: { notes } })
const cleanups: Array<() => Promise<unknown>> = []

beforeEach(() => {
  fake.enabled = true
  fake.pools.length = 0
  clearActiveCloudflareEnv()
})

afterEach(async () => {
  clearActiveCloudflareEnv()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("driver: \"node-postgres\"", () => {
  it("opens a pg Pool with the URL, keeps it as `db.$client`, and never loads postgres.js", async () => {
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    const db = createNodePostgresDatabase({ ...definition, connection: { url: "postgres://primary/app" } }, { binding: "HYPERDRIVE" })

    const client: unknown = Reflect.get(db, "$client")
    expect(fake.pools).toHaveLength(1)
    expect(fake.pools[0]!.options).toEqual({ connectionString: "postgres://primary/app" })
    expect(client).toBeInstanceOf((await import("pg")).default.Pool)
    expect(Reflect.get(db, "$client")).toBe(client)
    expect(postgresJs.loaded).toBe(false)
  })

  it("prefers Hyperdrive with five connections per Cloudflare request, and reads PG* variables without a URL", async () => {
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    const db = createNodePostgresDatabase({ ...definition, connection: { url: "postgres://primary/app" } }, { binding: "HYPERDRIVE" })
    runWithActiveCloudflareEnv({ HYPERDRIVE: { connectionString: "postgres://hyperdrive/app" } }, () => Reflect.get(db, "$client"))
    expect(fake.pools.at(-1)!.options).toEqual({ connectionString: "postgres://hyperdrive/app", max: 5 })

    vi.stubEnv("PGHOST", "db.internal")
    try {
      const fromEnv = createNodePostgresDatabase(definition, { binding: "HYPERDRIVE" })
      Reflect.get(fromEnv, "$client")
      expect(fake.pools.at(-1)!.options).toEqual({})
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    { username: "app_role", user: undefined, expected: "app_role" },
    { username: "app_role", user: "other_role", expected: "app_role" },
    { username: undefined, user: "pg_role", expected: "pg_role" },
  ])("resolves PGUSERNAME=$username and PGUSER=$user consistently with the CLI", async ({ username, user, expected }) => {
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    const { default: pg } = await import("pg")
    vi.stubEnv("PGHOST", "db.internal")
    vi.stubEnv("PGDATABASE", "app")
    vi.stubEnv("PGUSERNAME", username)
    vi.stubEnv("PGUSER", user)
    try {
      const db = createNodePostgresDatabase(definition, { binding: "HYPERDRIVE" })
      const pool = Reflect.get(db, "$client") as InstanceType<typeof pg.Pool>
      expect(new pg.Client(pool.options).user).toBe(expected)

      const withUrl = createNodePostgresDatabase({ ...definition, connection: { url: "postgres://url_role:secret@primary/app" } }, { binding: "HYPERDRIVE" })
      const urlPool = Reflect.get(withUrl, "$client") as InstanceType<typeof pg.Pool>
      expect(new pg.Client(urlPool.options).user).toBe("url_role")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("prints server warnings, drops notices, and keeps the process alive on an idle connection error", async () => {
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    Reflect.get(createNodePostgresDatabase({ ...definition, connection: { url: "postgres://primary/app" } }, { binding: "HYPERDRIVE" }), "$client")
    const { listeners } = fake.pools[0]!
    const clientListeners: Record<string, (notice: unknown) => void> = {}
    listeners.connect!({ on: (event: string, listener: (notice: unknown) => void) => { clientListeners[event] = listener } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      clientListeners.notice!({ message: "relation \"kv\" already exists, skipping", severity: "NOTICE" })
      clientListeners.notice!({ message: "disk almost full", severity: "WARNING" })
      listeners.error!(new Error("Connection terminated unexpectedly"))
      expect(warn.mock.calls).toEqual([["[vitehub] Postgres warning: disk almost full"]])
      expect(error.mock.calls).toEqual([["[vitehub] Postgres connection error: Connection terminated unexpectedly"]])
    }
    finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it("ends the superseded pool when the URL changes", async () => {
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    vi.stubEnv("VITEHUB_TEST_DATABASE_URL", "postgres://first/app")
    try {
      const db = createNodePostgresDatabase(definition, { binding: "HYPERDRIVE", url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_DATABASE_URL" } } })
      Reflect.get(db, "$client")
      vi.stubEnv("VITEHUB_TEST_DATABASE_URL", "postgres://second/app")
      Reflect.get(db, "$client")
      expect(fake.pools.map(pool => pool.options.connectionString)).toEqual(["postgres://first/app", "postgres://second/app"])
      expect(fake.pools[0]!.end).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})

const adminUrl = process.env.VITEHUB_TEST_POSTGRES_URL

describe.skipIf(!adminUrl)("driver: \"node-postgres\" on Postgres", () => {
  async function createDatabase() {
    const pg = (await import("pg")).default
    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    const name = `vitehub_pg_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    await admin.query(`create database ${name}`)
    cleanups.push(async () => {
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
    })
    const url = new URL(adminUrl!)
    url.pathname = `/${name}`
    return url.href
  }

  it("migrates on start through the Pool, then queries, counts, and runs transactions with Drizzle", { timeout: 30_000 }, async () => {
    fake.enabled = false
    const url = await createDatabase()
    const { createNodePostgresDatabase } = await import("../src/runtime/node-postgres.ts")
    const { migrateOnStart } = await import("../src/runtime/migrate-on-start.ts")
    const { runWithDatabaseRequestStats } = await import("../src/runtime/request-stats.ts")
    const db = createNodePostgresDatabase({ ...definition, connection: { url } }, { binding: "HYPERDRIVE" })
    cleanups.push(() => Reflect.get(db, "$client").end())

    const migration = { dataLoss: [], hash: "h1", name: "20260101000000_init", statements: ["CREATE TABLE \"notes\" (\"id\" integer PRIMARY KEY, \"title\" text NOT NULL);"], when: 1_767_225_600_000 }
    const log = vi.fn()
    await migrateOnStart([{ db, dialect: "postgresql", migrations: [migration], name: "default" }], { log })
    await migrateOnStart([{ db, dialect: "postgresql", migrations: [migration], name: "default" }], { log })
    expect(log.mock.calls.flat().filter(line => String(line).includes("applied"))).toEqual(["[vitehub] Database \"default\": applied 20260101000000_init."])

    let stats: unknown
    await runWithDatabaseRequestStats({ req: { context: { log: { set: (fields: Record<string, unknown>) => { stats = fields.database } } } } }, async () => {
      await db.insert(notes).values({ id: 1, title: "Ada" })
      await db.transaction(async (transaction) => {
        await transaction.insert(notes).values({ id: 2, title: "Grace" })
      })
    })
    expect(stats).toMatchObject({ calls: expect.any(Number) })
    expect((stats as { calls: number }).calls).toBeGreaterThanOrEqual(4)
    await expect(db.transaction(async (transaction) => {
      await transaction.insert(notes).values({ id: 3, title: "Linus" })
      throw new Error("roll back")
    })).rejects.toThrow("roll back")
    expect(await db.select().from(notes).orderBy(notes.id)).toEqual([{ id: 1, title: "Ada" }, { id: 2, title: "Grace" }])
    expect(await db.query.notes.findFirst({ where: { id: 2 } })).toEqual({ id: 2, title: "Grace" })
  })

  it("applies `vitehub database migrate` with node-postgres when the project has no postgres.js", { timeout: 30_000 }, async () => {
    fake.enabled = false
    const url = await createDatabase()
    const root = await mkdtemp(join(import.meta.dirname, ".node-postgres-migrate-"))
    cleanups.push(() => rm(root, { force: true, recursive: true }))
    // The project resolves `pg` from this package, and a `postgres` package that throws, so postgres.js cannot load.
    await mkdir(join(root, "node_modules/postgres"), { recursive: true })
    await writeFile(join(root, "node_modules/postgres/package.json"), JSON.stringify({ main: "index.js", name: "postgres" }))
    await writeFile(join(root, "node_modules/postgres/index.js"), "throw new Error('postgres.js must not load')\n")
    await writeFile(join(root, "package.json"), "{\"private\":true}")
    const migrationsDir = join(root, "migrations")
    await mkdir(join(migrationsDir, "20260101000000_init"), { recursive: true })
    await writeFile(join(migrationsDir, "20260101000000_init/migration.sql"), "CREATE TABLE \"notes\" (\"id\" integer PRIMARY KEY, \"title\" text NOT NULL);\n")
    // SAFETY: The migration plan reads only these fields of a resolved Database config.
    const database = { connection: { url }, dialect: "postgresql", driver: "node-postgres", migrationsDir, name: "default" } as ResolvedDrizzleDatabaseConfig
    const { migratePostgresDatabases, readMigrationPlan } = await import("../src/internal/migration-plan.ts")

    const [planError, plan] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(planError).toBeUndefined()
    expect(plan?.pending.map(migration => migration.name)).toEqual(["20260101000000_init"])
    expect(await migratePostgresDatabases([database], { allowDataLoss: false, env: {}, projectRoot: root }, () => {})).toBeUndefined()
    const [, after] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(after).toMatchObject({ applied: 1, pending: [] })
  })
})
