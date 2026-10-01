import { drizzle } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createConnectionsStore } from "../src/store.ts"
import { expectCode, testKey, tokenSet } from "./helpers.ts"

import type { ConnectionsStore } from "../src/store.ts"

describe("Connections store on D1", () => {
  let worker: Miniflare
  let store: ConnectionsStore

  beforeAll(async () => {
    worker = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    const db = drizzle(await worker.getD1Database("DB"))
    store = createConnectionsStore({ db, encryptionKey: testKey() })
  })

  afterAll(async () => { await worker?.dispose() })

  it("returns mutation rows for grant writes and keeps revision checks atomic", async () => {
    const tokens = tokenSet()
    const first = await store.write({ name: "gmail", provider: "google", tokens })
    expect(await store.tokens("gmail")).toEqual({ grant: first, tokens })

    const leases = await Promise.all([
      store.lease("gmail", first.revision, 1_000, 31_000),
      store.lease("gmail", first.revision, 1_000, 31_000),
    ])
    expect(leases.filter(Boolean)).toHaveLength(1)
    expect(await store.lease("gmail", "stale", 32_000, 62_000)).toBe(false)

    const refreshes = await Promise.allSettled([
      store.write({ expectedRevision: first.revision, name: "gmail", provider: "google", tokens: tokenSet({ accessToken: "second" }) }),
      store.write({ expectedRevision: first.revision, name: "gmail", provider: "google", tokens: tokenSet({ accessToken: "third" }) }),
    ])
    expect(refreshes.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const rejected = refreshes.find(result => result.status === "rejected")
    expect(rejected).toMatchObject({ reason: { code: "CONNECTIONS_UNAVAILABLE" } })

    const current = await store.grant("gmail")
    expect(current?.revision).not.toBe(first.revision)
    expect(current?.leaseUntil).toBeUndefined()
    await store.release("gmail", first.revision, "error", "stale-refresh")
    await store.deleteGrant("gmail", first.revision)
    expect(await store.grant("gmail")).toEqual(current)

    const reconnect = await store.write({ name: "gmail", provider: "google", tokens })
    expect(reconnect.revision).not.toBe(current?.revision)
    await expectCode(store.write({ expectedRevision: first.revision, name: "gmail", provider: "google", tokens }), "CONNECTIONS_UNAVAILABLE")
    await store.deleteGrant("gmail", reconnect.revision)
    expect(await store.grant("gmail")).toBeUndefined()
  })

  it("opens and consumes each pending flow once through mutation RETURNING", async () => {
    const pending = {
      actor: { id: "admin", kind: "user" as const },
      expiresAt: 10_000,
      name: "gmail",
      redirectUri: "https://app.example/callback",
      state: "state-1",
      ticket: "ticket-1",
      verifier: "verifier-1",
    }
    const { expiresAt: _expiresAt, ticket: _ticket, ...payload } = pending
    await store.createPending(pending)
    const opens = await Promise.all([store.openPending(pending.ticket, 1_000), store.openPending(pending.ticket, 1_000)])
    expect(opens.filter(Boolean)).toEqual([payload])
    const consumes = await Promise.all([store.consumePending(pending.state, 1_000), store.consumePending(pending.state, 1_000)])
    expect(consumes.filter(Boolean)).toEqual([payload])
    expect(await store.consumePending(pending.state, 1_000)).toBeUndefined()

    await store.createPending({ ...pending, state: "expired", ticket: "expired" })
    expect(await store.openPending("expired", 10_001)).toBeUndefined()
    expect(await store.consumePending("expired", 10_001)).toBeUndefined()
  })
})
