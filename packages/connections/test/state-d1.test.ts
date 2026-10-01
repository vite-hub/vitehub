import { drizzle } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"

import { createDatabaseConnectionStore } from "../src/store.ts"

it("guards Connection metadata atomically against the D1 token revision", async () => {
  const worker = new Miniflare({ compatibilityDate: "2026-07-14", d1Databases: ["DB"], modules: true, script: "export default { fetch() { return new Response('test') } }" })
  try {
    const store = createDatabaseConnectionStore({ db: drizzle(await worker.getD1Database("DB")), encryptionKey: new Uint8Array(32).fill(9) })
    const state = { name: "mail", scopes: ["mail.read"], status: "connected" as const, updatedAt: "2026-09-30T00:00:00Z" }
    expect(await store.state.putForToken(state, null)).toBe(true)
    const first = await store.secrets.replace({ key: "connection/mail", value: "token-one", expectedRevision: null })
    expect(await store.state.putForToken(state, null)).toBe(false)
    expect(await store.state.putForToken(state, first.revision)).toBe(true)
    const second = await store.secrets.replace({ key: "connection/mail", value: "token-two", expectedRevision: first.revision })
    expect(await store.state.putForToken({ ...state, status: "revoked" }, second.revision)).toBe(true)
    expect(await store.state.putForToken(state, first.revision)).toBe(false)
    expect(await store.state.get("mail")).toMatchObject({ status: "revoked" })
  }
  finally { await worker.dispose() }
})
