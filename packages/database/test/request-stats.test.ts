import { createClient } from "@libsql/client"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"
import { sql } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"

import { createDrizzleSqliteAdapter } from "../src/runtime/drizzle-adapter.ts"
import {
  runWithDatabaseRequestStats,
  trackD1Database,
  trackDatabaseCall,
  trackPostgresClient,
} from "../src/runtime/request-stats.ts"

function requestWithLogger() {
  const set = vi.fn()
  return { event: { req: { context: { log: { set } } } }, set }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe("database request stats", () => {
  it("sets the request's calls, waiting time, and concurrency on its wide event", async () => {
    const { event, set } = requestWithLogger()
    const result = await runWithDatabaseRequestStats(event, async () => {
      await trackDatabaseCall(() => wait(20))
      await trackDatabaseCall(() => wait(20))
      await Promise.all([trackDatabaseCall(() => wait(20)), trackDatabaseCall(() => wait(20)), trackDatabaseCall(() => wait(20))])
      return "page"
    })

    expect(result).toBe("page")
    expect(set).toHaveBeenCalledOnce()
    const { database } = set.mock.calls[0]![0] as { database: { calls: number, maxConcurrent: number, ms: number } }
    expect(database.calls).toBe(5)
    expect(database.maxConcurrent).toBe(3)
    // Three waits in a row: two alone and one for the three together, not five.
    expect(database.ms).toBeGreaterThanOrEqual(55)
    expect(database.ms).toBeLessThan(95)
  })

  it("keeps requests apart when they run at the same time", async () => {
    const first = requestWithLogger()
    const second = requestWithLogger()
    await Promise.all([
      runWithDatabaseRequestStats(first.event, async () => {
        await trackDatabaseCall(() => wait(5))
        await trackDatabaseCall(() => wait(5))
      }),
      runWithDatabaseRequestStats(second.event, () => trackDatabaseCall(() => wait(5))),
    ])

    expect(first.set.mock.calls[0]![0]).toMatchObject({ database: { calls: 2, maxConcurrent: 1 } })
    expect(second.set.mock.calls[0]![0]).toMatchObject({ database: { calls: 1, maxConcurrent: 1 } })
  })

  it("reports a request that fails, and leaves out requests without calls or without a logger", async () => {
    const failed = requestWithLogger()
    await expect(runWithDatabaseRequestStats(failed.event, async () => {
      await trackDatabaseCall(() => Promise.reject(new Error("no such table")))
    })).rejects.toThrow("no such table")
    expect(failed.set.mock.calls[0]![0]).toMatchObject({ database: { calls: 1 } })

    const quiet = requestWithLogger()
    await runWithDatabaseRequestStats(quiet.event, () => "no database")
    expect(quiet.set).not.toHaveBeenCalled()

    const next = vi.fn(() => "as it is")
    expect(runWithDatabaseRequestStats({ req: { context: {} } }, next)).toBe("as it is")
  })

  it("does not count work that continues after the response", async () => {
    const { event, set } = requestWithLogger()
    let later: Promise<unknown> | undefined
    await runWithDatabaseRequestStats(event, async () => {
      await trackDatabaseCall(() => wait(1))
      later = wait(10).then(() => trackDatabaseCall(() => wait(1)))
    })
    await later
    expect(set).toHaveBeenCalledOnce()
    expect(set.mock.calls[0]![0]).toMatchObject({ database: { calls: 1 } })
  })

  it("counts each libSQL query that Drizzle runs", async () => {
    const db = createDrizzleSqliteAdapter({ connection: { url: ":memory:" }, drizzle: {}, name: "test" }, {}, {
      libsql: { createClient, drizzle: drizzleLibsql as never },
      missingConnection: "a connection",
      requireRemoteUrl: false,
    })
    const { event, set } = requestWithLogger()
    await runWithDatabaseRequestStats(event, async () => {
      await db.run(sql`create table notes (title text)`)
      await db.run(sql`insert into notes values ('a')`)
      await Promise.all([db.all(sql`select * from notes`), db.all(sql`select count(*) from notes`)])
      await db.batch([db.run(sql`insert into notes values ('b')`), db.run(sql`insert into notes values ('c')`)])
    })
    expect(set.mock.calls[0]![0]).toMatchObject({ database: { calls: 5, maxConcurrent: 2 } })
  })

  it("counts D1 statements and batches, and hands D1 its own statement objects", async () => {
    class Statement {
      constructor(readonly query: string, readonly params: unknown[] = []) {}
      bind(...params: unknown[]) { return new Statement(this.query, params) }
      async all() { return { results: [] } }
      async raw() { return [] }
      async run() { return {} }
      async first() { return null }
    }
    const batched: unknown[] = []
    const binding = {
      prepare: (query: string) => new Statement(query),
      batch: async (statements: unknown[]) => {
        batched.push(...statements)
        // Like D1, the batch only takes the binding's own statements.
        expect(statements.every(statement => statement instanceof Statement)).toBe(true)
        return statements.map(() => ({ results: [] }))
      },
    }
    const d1 = trackD1Database(binding)
    const { event, set } = requestWithLogger()
    await runWithDatabaseRequestStats(event, async () => {
      const select = d1.prepare("select ?")
      await select.bind(1).all()
      await select.bind(2).first()
      await d1.batch([d1.prepare("insert").bind(1), d1.prepare("insert").bind(2)])
    })
    expect(batched).toHaveLength(2)
    expect(set.mock.calls[0]![0]).toMatchObject({ database: { calls: 3, maxConcurrent: 1 } })
  })

  it("counts a postgres.js query once, when it runs, also inside a transaction", async () => {
    const run = vi.fn()
    // postgres.js queries are promises that start when they are first awaited.
    const query = (_sql: string) => {
      // eslint-disable-next-line unicorn/no-thenable -- a postgres.js query is a thenable that runs on its first then()
      const pending = { values: () => pending, then: (resolve: (value: unknown) => void) => { run(); resolve([]) } }
      return pending
    }
    const client = Object.assign(() => undefined, {
      unsafe: query,
      begin: async (callback: (transaction: { unsafe: typeof query }) => Promise<unknown>) => callback({ unsafe: query }),
    })
    const postgres = trackPostgresClient(client)
    const { event, set } = requestWithLogger()
    await runWithDatabaseRequestStats(event, async () => {
      const pending = postgres.unsafe("select 1").values()
      await pending
      await pending
      await postgres.begin(async transaction => transaction.unsafe("update notes"))
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(set.mock.calls[0]![0]).toMatchObject({ database: { calls: 2 } })
  })

  it("counts a callable postgres.js tagged-template query", async () => {
    const run = vi.fn()
    const client = Object.assign((..._args: unknown[]) => ({
      then(resolve: (value: unknown) => void) { run(); resolve([]) },
    }), { unsafe: () => undefined })
    const postgres = trackPostgresClient(client)
    const { event, set } = requestWithLogger()
    await runWithDatabaseRequestStats(event, async () => { await postgres`select 1` })
    expect(run).toHaveBeenCalledOnce()
    expect(set.mock.calls[0]![0]).toMatchObject({ database: { calls: 1 } })
  })

})
