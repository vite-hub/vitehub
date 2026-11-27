import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import { runIdempotent } from "../src/runtime/idempotency.ts"

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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const pglite = new PGlite()
const server = process.env.VITEHUB_TEST_POSTGRES_URL ? postgres(process.env.VITEHUB_TEST_POSTGRES_URL, { onnotice: () => {} }) : undefined
afterAll(async () => {
  await pglite.close()
  await server?.end()
})

// Each case starts without the keys table. A Postgres database is shared, so the case drops the table first.
const dialects: [string, () => Promise<IdempotencyDatabase>][] = [
  ["SQLite", async () => drizzleLibsql({ client: createClient({ url: ":memory:" }) })],
  ["PGlite", async () => {
    await pglite.exec("DROP TABLE IF EXISTS vitehub_idempotency_keys")
    return drizzlePglite({ client: pglite })
  }],
  ...server ? [["Postgres", async () => {
    await server`DROP TABLE IF EXISTS vitehub_idempotency_keys`
    return drizzlePostgres({ client: server })
  }] satisfies [string, () => Promise<IdempotencyDatabase>]] : [],
]

describe.each(dialects)("runIdempotent() on %s", (_dialect, fresh) => {

  it("runs fn once and gives a repeat the stored result", async () => {
    const db = await fresh()
    const fn = vi.fn(async () => ({ order: 42, paid: true }))

    expect(await runIdempotent(db, "stripe:evt_1", fn)).toEqual([undefined, { order: 42, paid: true }])
    expect(await runIdempotent(db, "stripe:evt_1", fn)).toEqual([undefined, { order: 42, paid: true }])
    expect(await runIdempotent(db, "stripe:evt_2", fn)).toEqual([undefined, { order: 42, paid: true }])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("replays a result of undefined and of null", async () => {
    const db = await fresh()
    expect(await runIdempotent(db, "none", () => undefined)).toEqual([undefined, undefined])
    expect(await runIdempotent(db, "none", () => "ran again")).toEqual([undefined, undefined])
    expect(await runIdempotent(db, "null", () => null)).toEqual([undefined, null])
    expect(await runIdempotent(db, "null", () => "ran again")).toEqual([undefined, null])
  })

  it("refuses a repeat while the first call runs, then replays its result", async () => {
    const db = await fresh()
    const started = deferred()
    const gate = deferred()
    const first = runIdempotent(db, "mail:rsvp-7", async () => {
      started.resolve()
      await gate.promise
      return "sent"
    })
    await started.promise
    const [error] = await runIdempotent(db, "mail:rsvp-7", () => "duplicate")
    expect(error?.code).toBe("DATABASE_IDEMPOTENCY_IN_PROGRESS")
    expect(error?.why).toBe("Another call with the key \"mail:rsvp-7\" is running.")
    gate.resolve()
    expect(await first).toEqual([undefined, "sent"])
    expect(await runIdempotent(db, "mail:rsvp-7", () => "duplicate")).toEqual([undefined, "sent"])
  })

  it("lets exactly one of many parallel calls run fn", async () => {
    const db = await fresh()
    const fn = vi.fn(async () => "charged")
    const results = await Promise.all(Array.from({ length: 8 }, () => runIdempotent(db, "charge:1", fn)))

    expect(fn).toHaveBeenCalledTimes(1)
    for (const [error, value] of results) {
      if (error) expect(error.code).toBe("DATABASE_IDEMPOTENCY_IN_PROGRESS")
      else expect(value).toBe("charged")
    }
  })

  it("frees the key when fn throws, so a retry runs fn again", async () => {
    const db = await fresh()
    const failure = new Error("provider down")
    await expect(runIdempotent(db, "mail:1", () => { throw failure })).rejects.toBe(failure)
    expect(await runIdempotent(db, "mail:1", () => "sent")).toEqual([undefined, "sent"])
  })

  it("runs fn again after the result ttl ends, and after a crashed call's timeout ends", async () => {
    const db = await fresh()
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)

    await runIdempotent(db, "lesson:day-1", () => "first", { ttl: 10 })
    clock.mockReturnValue(now + 9_000)
    expect(await runIdempotent(db, "lesson:day-1", () => "second")).toEqual([undefined, "first"])
    clock.mockReturnValue(now + 10_000)
    expect(await runIdempotent(db, "lesson:day-1", () => "second")).toEqual([undefined, "second"])

    // A call that never finishes holds the key for `timeout` seconds.
    const started = deferred()
    void runIdempotent(db, "crashed", () => {
      started.resolve()
      return new Promise<never>(() => {})
    }, { timeout: 5 })
    await started.promise
    const [error] = await runIdempotent(db, "crashed", () => "retry")
    expect(error?.code).toBe("DATABASE_IDEMPOTENCY_IN_PROGRESS")
    clock.mockReturnValue(now + 15_000)
    expect(await runIdempotent(db, "crashed", () => "retry")).toEqual([undefined, "retry"])
  })

  it("keeps the result of the call that holds the key when an expired call finishes late", async () => {
    const db = await fresh()
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const started = deferred()
    const gate = deferred()
    const slow = runIdempotent(db, "webhook:1", async () => {
      started.resolve()
      await gate.promise
      return "slow"
    }, { timeout: 1 })
    await started.promise
    clock.mockReturnValue(now + 2_000)
    expect(await runIdempotent(db, "webhook:1", () => "fast")).toEqual([undefined, "fast"])
    gate.resolve()
    expect(await slow).toEqual([undefined, "slow"])
    expect(await runIdempotent(db, "webhook:1", () => "again")).toEqual([undefined, "fast"])
  })

  it("returns DATABASE_IDEMPOTENCY_INVALID_OPTIONS for an empty key or a bad ttl or timeout", async () => {
    const db = await fresh()
    const fn = vi.fn()
    const [key] = await runIdempotent(db, "", fn)
    const [ttl] = await runIdempotent(db, "k", fn, { ttl: 0 })
    const [timeout] = await runIdempotent(db, "k", fn, { timeout: Number.NaN })

    expect([key?.code, ttl?.code, timeout?.code]).toEqual(Array.from({ length: 3 }, () => "DATABASE_IDEMPOTENCY_INVALID_OPTIONS"))
    expect(key?.why).toBe("`withIdempotency()` needs a key that is a non-empty string.")
    expect(ttl?.why).toBe("`ttl` of `withIdempotency()` must be a positive number of seconds.")
    expect(fn).not.toHaveBeenCalled()
  })
})

it("recovers when table and index creation each encounter Postgres catalog contention", async () => {
  const backend = new PGlite()
  const db = drizzlePglite({ client: backend })
  let calls = 0
  const contended: IdempotencyDatabase = {
    async execute(statement) {
      calls++
      // Another instance can win table creation, then a different instance can win index creation.
      if (calls === 1 || calls === 3) throw Object.assign(new Error("catalog contention"), { code: "23505" })
      return await db.execute(statement)
    },
  }
  try {
    expect(await runIdempotent(contended, "first-use", () => "done")).toEqual([undefined, "done"])
  }
  finally {
    await backend.close()
  }
})

it("runs fn and keeps the result when the delete of expired keys fails", async () => {
  const backend = new PGlite()
  const db = drizzlePglite({ client: backend })
  const dialect = new PgDialect()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const sweepFails: IdempotencyDatabase = {
    async execute(statement) {
      if (dialect.sqlToQuery(statement).sql.startsWith("DELETE FROM vitehub_idempotency_keys WHERE expires_at")) {
        throw new Error("database is locked")
      }
      return await db.execute(statement)
    },
  }
  try {
    const fn = vi.fn(() => "sent")
    expect(await runIdempotent(sweepFails, "mail:welcome", fn)).toEqual([undefined, "sent"])
    expect(await runIdempotent(sweepFails, "mail:welcome", fn)).toEqual([undefined, "sent"])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledOnce()
  }
  finally {
    warn.mockRestore()
    await backend.close()
  }
})

describe.runIf(server)("runIdempotent() on Postgres with several processes", () => {
  it("creates the table once when the first calls of many clients race", async () => {
    await server!`DROP TABLE IF EXISTS vitehub_idempotency_keys`
    const clients = Array.from({ length: 12 }, () => postgres(process.env.VITEHUB_TEST_POSTGRES_URL!, { max: 1, onnotice: () => {} }))
    try {
      await Promise.all(clients.map(client => client`SELECT 1`))
      const fn = vi.fn(async () => "done")
      const results = await Promise.all(clients.map(client => runIdempotent(drizzlePostgres({ client }), "same-key", fn)))

      expect(fn).toHaveBeenCalledTimes(1)
      for (const [error, value] of results) {
        if (error) expect(error.code).toBe("DATABASE_IDEMPOTENCY_IN_PROGRESS")
        else expect(value).toBe("done")
      }
    }
    finally {
      await Promise.all(clients.map(client => client.end()))
    }
  })
})

describe("withIdempotency()", () => {
  it("stores the keys in the default Database of the app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-idempotency-"))
    const mode = enableViteHubTestMode({ root })
    try {
      const { db, withIdempotency } = await import("../src/index.ts")
      const fn = vi.fn(() => ({ sent: true }))

      expect(await withIdempotency("mail:welcome:ada@example.com", fn)).toEqual([undefined, { sent: true }])
      expect(await withIdempotency("mail:welcome:ada@example.com", fn)).toEqual([undefined, { sent: true }])
      expect(fn).toHaveBeenCalledTimes(1)
      expect(await db.all(sql`SELECT id, claim, result FROM vitehub_idempotency_keys`)).toEqual([
        { id: "mail:welcome:ada@example.com", claim: null, result: "{\"sent\":true}" },
      ])

      // A reset gives the same Database a new, empty backend.
      await mode.reset()
      expect(await withIdempotency("mail:welcome:ada@example.com", fn)).toEqual([undefined, { sent: true }])
      expect(fn).toHaveBeenCalledTimes(2)
      expect(() => withIdempotency("k", fn, { database: "analytics" })).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }))
    }
    finally {
      await mode.reset()
      Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
      await rm(root, { force: true, recursive: true })
    }
  })
})
