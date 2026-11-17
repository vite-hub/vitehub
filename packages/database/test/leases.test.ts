import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import pg from "pg"
import postgres from "postgres"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { createDatabaseLeaseStore } from "../src/runtime/leases.ts"

import type { IdempotencyDatabase } from "../src/runtime/idempotency.ts"

vi.mock("@vite-hub/database/runtime/registry", () => import("../src/runtime/registry.ts"))
vi.mock("#vitehub/database/databases", () => ({
  default: {
    default: {
      config: {
        connection: { url: "file:unused.sqlite" },
        dialect: "sqlite",
        generatedSchemaFile: ".vitehub/database/schema/default.ts",
        migrationsDir: "server/databases/default/migrations",
        mode: "default",
        name: "default",
        orm: "drizzle",
      },
      relations: {},
      schema: {},
    },
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A D1 binding on `node:sqlite`, with the methods that Drizzle's D1 driver calls. Like D1, it has no interactive
 * transaction, so the store must do each operation in one statement.
 */
function createD1(): object {
  const sqlite = new DatabaseSync(":memory:")
  const statement = (query: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(query, values),
    all: async () => ({ results: sqlite.prepare(query).all(...params as never[]), success: true, meta: {} }),
    raw: async () => sqlite.prepare(query).all(...params as never[]).map(row => Object.values(row)),
    run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...params as never[]) }),
  })
  return { prepare: (query: string) => statement(query), batch: async () => [] }
}

const pglite = new PGlite()
const server = process.env.VITEHUB_TEST_POSTGRES_URL ? postgres(process.env.VITEHUB_TEST_POSTGRES_URL, { onnotice: () => {} }) : undefined
const pool = process.env.VITEHUB_TEST_POSTGRES_URL ? new pg.Pool({ connectionString: process.env.VITEHUB_TEST_POSTGRES_URL }) : undefined
afterAll(async () => {
  await pglite.close()
  await server?.end()
  await pool?.end()
})

// Each case starts without the leases table. A Postgres database is shared, so the case drops the table first.
const drivers: [string, () => Promise<IdempotencyDatabase>][] = [
  ["libSQL", async () => drizzleLibsql({ client: createClient({ url: ":memory:" }) })],
  // SAFETY: the stand-in has the D1 methods that Drizzle calls.
  ["D1", async () => drizzleD1(createD1() as never)],
  ["PGlite", async () => {
    await pglite.exec("DROP TABLE IF EXISTS vitehub_leases")
    return drizzlePglite({ client: pglite })
  }],
  ...server && pool
    ? [
        ["postgres.js", async () => {
          await server`DROP TABLE IF EXISTS vitehub_leases`
          return drizzlePostgres({ client: server })
        }],
        ["node-postgres", async () => {
          await pool.query("DROP TABLE IF EXISTS vitehub_leases")
          return drizzleNodePostgres({ client: pool })
        }],
      ] satisfies [string, () => Promise<IdempotencyDatabase>][]
    : [],
]

describe.each(drivers)("createDatabaseLeaseStore() on %s", (_driver, fresh) => {
  it("gives a key to one caller until it releases the lease", async () => {
    const leases = createDatabaseLeaseStore(await fresh())

    const [error, lease] = await leases.acquire("sync:stripe-payouts", { ttl: 30, owner: "web-1" })
    expect(error).toBeUndefined()
    expect(lease).toMatchObject({ key: "sync:stripe-payouts", owner: "web-1" })
    expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25_000)

    expect(await leases.acquire("sync:stripe-payouts", { ttl: 30, owner: "web-2" })).toEqual([undefined, null])
    expect(await leases.get("sync:stripe-payouts")).toEqual([undefined, { key: "sync:stripe-payouts", id: lease!.id, owner: "web-1", expiresAt: lease!.expiresAt }])

    expect(await lease!.renew({ ttl: 60 })).toEqual([undefined, true])
    expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 55_000)
    expect(await lease!.release()).toEqual([undefined, true])
    expect(await leases.get("sync:stripe-payouts")).toEqual([undefined, null])

    const [, next] = await leases.acquire("sync:stripe-payouts", { ttl: 30 })
    expect(next).not.toBeNull()
    // The old holder can no longer renew or release the key.
    expect(await lease!.renew()).toEqual([undefined, false])
    expect(await lease!.release()).toEqual([undefined, false])
  })

  it("gives an expired lease to the next caller", async () => {
    const leases = createDatabaseLeaseStore(await fresh())

    const [, first] = await leases.acquire("leader", { ttl: 0.05 })
    await new Promise(resolve => setTimeout(resolve, 100))
    const [, second] = await leases.acquire("leader", { ttl: 30 })

    expect(second).not.toBeNull()
    expect(second!.id).not.toBe(first!.id)
    expect(await first!.renew()).toEqual([undefined, false])
  })

  it("gives one of many callers that race for a key the lease", async () => {
    const db = await fresh()
    const results = await Promise.all(Array.from({ length: 8 }, () => createDatabaseLeaseStore(db).acquire("report:daily", { ttl: 30 })))

    expect(results.filter(([, lease]) => lease).length).toBe(1)
    expect(results.every(([error]) => error === undefined)).toBe(true)
  })
})

it("returns RUNTIME_LEASE_FAILED with the Database error as the cause", async () => {
  const client = createClient({ url: ":memory:" })
  const leases = createDatabaseLeaseStore(drizzleLibsql({ client }))
  client.close()

  const [error] = await leases.acquire("sync:stripe-payouts", { ttl: 30 })

  expect(error).toMatchObject({ code: "RUNTIME_LEASE_FAILED", cause: expect.any(Error) })
})

it("warns that leases in a local libSQL file are for one process only", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), "vitehub-leases-"))
  const client = createClient({ url: `file:${join(root, "app.sqlite")}` })
  try {
    // A fresh module: the store warns once per process, and the `:memory:` clients above are files too.
    vi.resetModules()
    const { createDatabaseLeaseStore: fresh } = await import("../src/runtime/leases.ts")
    await fresh(drizzleLibsql({ client })).get("leader")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("local libSQL file"))
  }
  finally {
    client.close()
    await rm(root, { force: true, recursive: true })
  }
})

describe("useLeases()", () => {
  it("keeps the leases in the default Database of the app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-leases-"))
    const mode = enableViteHubTestMode({ root })
    try {
      const { db, useLeases } = await import("../src/index.ts")

      expect(useLeases()).toBe(useLeases())
      const [, lease] = await useLeases().acquire("sync:github-issues", { ttl: 30, owner: "web-1" })
      expect(lease).not.toBeNull()
      expect(await db.all(sql`SELECT "key", owner FROM vitehub_leases`)).toEqual([{ key: "sync:github-issues", owner: "web-1" }])

      // A reset gives the same Database a new, empty backend, so the store creates the table again.
      await mode.reset()
      expect(await useLeases().get("sync:github-issues")).toEqual([undefined, null])
      expect((await useLeases().acquire("sync:github-issues", { ttl: 30 }))[1]).not.toBeNull()
      expect(() => useLeases({ database: "analytics" })).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }))
    }
    finally {
      await mode.reset()
      Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
      await rm(root, { force: true, recursive: true })
    }
  })
})
