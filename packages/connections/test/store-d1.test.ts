import { drizzle } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDatabaseConnectionStore } from "../src/store.ts"
import { createTestRuntime, mailConnection } from "./helpers.ts"
import type { ConnectionStore } from "../src/store.ts"

describe("Connections store on D1", () => {
  let worker: Miniflare
  let store: ConnectionStore
  beforeAll(async () => {
    worker = new Miniflare({ compatibilityDate: "2026-07-14", d1Databases: ["DB"], modules: true, script: "export default { fetch() { return new Response('test') } }" })
    store = createDatabaseConnectionStore({ db: drizzle(await worker.getD1Database("DB")), encryptionKey: new Uint8Array(32).fill(3) })
  })
  afterAll(async () => { await worker?.dispose() })

  it("returns token replacements and keeps revision checks atomic", async () => {
    const key = "connection/gmail"
    const first = await store.secrets.replace({ key, value: "first-token", expectedRevision: null })
    expect(await store.secrets.read(key)).toMatchObject({ value: "first-token", revision: first.revision })
    const leases = await Promise.all(["one", "two"].map(owner => store.refreshLeases.claim({ name: "gmail", owner, revision: first.revision, now: 1000, expiresAt: 31000 })))
    expect(leases.filter(result => result === "acquired")).toHaveLength(1)
    expect(leases.filter(result => result === "busy")).toHaveLength(1)
    const replacements = await Promise.allSettled(["second-token", "third-token"].map(value => store.secrets.replace({ key, value, expectedRevision: first.revision })))
    expect(replacements.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(replacements.filter(result => result.status === "rejected")).toHaveLength(1)
    const current = await store.secrets.inspect(key)
    expect(current?.revision).not.toBe(first.revision)
    const metadata = { name: "gmail", scopes: ["mail.read"], status: "connected" as const, updatedAt: "2026-09-30T00:00:00Z" }
    expect(await store.state.putForToken(metadata, first.revision)).toBe(false)
    expect(await store.state.get("gmail")).toBeUndefined()
    expect(await store.state.putForToken(metadata, current!.revision)).toBe(true)
    expect(await store.state.get("gmail")).toEqual(metadata)
    await store.refreshLeases.release("gmail", "wrong-owner")
    expect(await store.refreshLeases.claim({ name: "gmail", owner: "other", revision: current!.revision, now: 32000, expiresAt: 62000 })).toBe("expired")
  })

  it("consumes each pending authorization once through mutation RETURNING", async () => {
    const authorization = { actor: "user:admin", expiresAt: 10000, name: "gmail", redirectUri: "https://app.example/callback", state: "state-1", verifier: "verifier-1" }
    await store.authorizations.put(authorization)
    const consumes = await Promise.all([store.authorizations.take(authorization.state), store.authorizations.take(authorization.state)])
    expect(consumes.filter(Boolean)).toEqual([authorization])
    expect(await store.authorizations.take(authorization.state)).toBeUndefined()
    await store.authorizations.put({ ...authorization, state: "expired" })
    const test = createTestRuntime(mailConnection(), store)
    await expect(test.runtime.complete({ code: "code", state: "expired" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toEqual([])
    expect(await store.authorizations.take("expired")).toBeUndefined()
  })
})
