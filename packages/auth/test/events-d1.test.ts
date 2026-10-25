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
