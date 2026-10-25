import { drizzle } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, it } from "vitest"
import { createDatabaseAuthEventStore } from "../src/events.ts"
import type { AuthEventStore } from "../src/events.ts"

let worker: Miniflare
let store: AuthEventStore
beforeAll(async () => {
  worker = new Miniflare({ host: "127.0.0.1", port: 17843, compatibilityDate: "2026-07-14", d1Databases: ["DB"], modules: true, script: "export default { fetch() { return new Response('auth events test') } }" })
  store = createDatabaseAuthEventStore({ db: drizzle(await worker.getD1Database("DB")), retention: { maxRecords: 3 } })
})
afterAll(async () => { await worker?.dispose() })

it("records, filters, paginates, aggregates and prunes on real local D1", async () => {
  const time = new Date().toISOString()
  for (const id of ["a", "b", "c", "d"]) await store.append({ id, time, type: "user.signed_in", actor: "user:u1", userId: "u1", metadata: { method: "email-password" } })
  const first = await store.list({ actor: "user:u1", userId: "u1", type: "user.signed_in", limit: 2 })
  expect(first.events.map(event => event.id)).toEqual(["d", "c"])
  expect((await store.list({ cursor: first.nextCursor })).events.map(event => event.id)).toEqual(["b"])
  const window = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }
  expect((await store.aggregate(window)).totals).toEqual({ signUps: 0, signIns: 3, activeUsers: 1, methods: { "email-password": 3 } })
  const restarted = createDatabaseAuthEventStore({ db: drizzle(await worker.getD1Database("DB")) })
  expect((await restarted.list()).events).toHaveLength(3)
})

it("keeps D1 aggregates consistent when a write follows the first read", async () => {
  const db = drizzle(await worker.getD1Database("DB"))
  const all = db.all.bind(db)
  let reads = 0
  const concurrent: AuthEventStore = createDatabaseAuthEventStore({ db: {
    run: query => db.run(query),
    async all(query) {
      const rows = await all(query)
      if (++reads === 1) await concurrent.append({ ...event, id: "during", userId: "u2" })
      return rows
    },
  }, retention: false })
  const event = { id: "before", time: "2025-01-01T12:00:00.000Z", type: "user.signed_in" as const, actor: "user:u1" as const, userId: "u1", metadata: { method: "email-password" } }
  await concurrent.append(event)
  const window = { from: "2025-01-01T00:00:00.000Z", to: "2025-01-02T00:00:00.000Z" }
  const result = await concurrent.aggregate(window)
  expect(result.totals).toEqual({ signUps: 0, signIns: 1, activeUsers: 1, methods: { "email-password": 1 } })
  expect(result.days[0]?.methods).toEqual(result.totals.methods)
  expect(reads).toBe(1)
  expect((await concurrent.aggregate(window)).totals.signIns).toBe(2)
})
