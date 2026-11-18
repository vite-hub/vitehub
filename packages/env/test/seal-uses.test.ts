import { createClient } from "@libsql/client"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle } from "drizzle-orm/libsql"
import { Miniflare } from "miniflare"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { seal, unseal } from "../src/index.ts"

const root = "seal-test-root-secret-at-least-32-characters"
const cleanup: Array<() => void | Promise<void>> = []

function flip(sealed: string, index: number): string {
  const bytes = Uint8Array.from(atob(sealed.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0))
  bytes[index]! ^= 1
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Each call is one app instance with its own connection to the same database file.
async function sharedDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-seal-uses-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const url = `file:${join(dir, "app.db")}`
  return () => {
    const client = createClient({ url })
    cleanup.push(() => client.close())
    return { client, db: drizzle({ client }) }
  }
}

beforeEach(() => {
  vi.stubEnv("VITEHUB_SECRET", root)
  vi.stubEnv("NUXT_APP_SECRET", "")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) await close()
})

describe("seal with uses", () => {
  it("opens once, then returns ENV_SEAL_USED_UP", async () => {
    const { db } = (await sharedDatabase())()
    const link = await seal("app:share", { token: "sk_live_123" }, { uses: 1, db })
    expect(await unseal("app:share", link, { db })).toEqual([undefined, { token: "sk_live_123" }])
    const [error, value] = await unseal("app:share", link, { db })
    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      code: "ENV_SEAL_USED_UP",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_used_up",
    })
    expect(error?.fix).toContain("Seal a new value")
  })

  it("opens N times across instances", async () => {
    const connect = await sharedDatabase()
    const link = await seal("app:share", "hello", { uses: 3, db: connect().db })
    const results = []
    for (let read = 0; read < 4; read++) results.push((await unseal("app:share", link, { db: connect().db }))[0]?.code)
    expect(results).toEqual([undefined, undefined, undefined, "ENV_SEAL_USED_UP"])
  })

  it("gives the last use to exactly one of two concurrent reads", async () => {
    const connect = await sharedDatabase()
    for (let round = 0; round < 10; round++) {
      const link = await seal("app:share", { round }, { uses: 1, db: connect().db })
      const results = await Promise.all([connect(), connect()].map(({ db }) => unseal("app:share", link, { db })))
      expect(results.filter(([error]) => !error)).toEqual([[undefined, { round }]])
      expect(results.filter(([error]) => error?.code === "ENV_SEAL_USED_UP")).toHaveLength(1)
    }
  })

  it("returns ENV_SEAL_EXPIRED after the ttl, and deletes the row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { client, db } = (await sharedDatabase())()
    const link = await seal("app:share", "hello", { uses: 5, ttl: 60, db })
    vi.setSystemTime(Date.now() + 61_000)
    const [error] = await unseal("app:share", link, { db })
    expect(error?.code).toBe("ENV_SEAL_EXPIRED")
    expect((await client.execute("SELECT * FROM vitehub_env_seal_uses")).rows).toEqual([])
  })

  it("keeps only an id, the uses, and the expiry in the database", async () => {
    const { client, db } = (await sharedDatabase())()
    await seal("app:share", { token: "sk_live_secret_value" }, { uses: 2, ttl: 60, db })
    const { columns, rows } = await client.execute("SELECT * FROM vitehub_env_seal_uses")
    expect(columns).toEqual(["id", "uses", "expires_at"])
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain("sk_live")
    expect(rows[0]).toMatchObject({ id: expect.stringMatching(/^[\da-f]{32}$/), uses: 2 })
  })

  it("deletes the row when the last use is taken", async () => {
    const { client, db } = (await sharedDatabase())()
    const link = await seal("app:share", "hello", { uses: 1, db })
    await unseal("app:share", link, { db })
    expect((await client.execute("SELECT * FROM vitehub_env_seal_uses")).rows).toEqual([])
  })

  it.each([
    ["the version", 0],
    ["the expiry", 8],
    ["the id", 20],
    ["the IV", 32],
    ["the ciphertext", 50],
  ])("returns ENV_SEAL_INVALID when %s changes and keeps the use", async (_part, index) => {
    const { db } = (await sharedDatabase())()
    const link = await seal("app:share", { role: "member" }, { uses: 1, ttl: 60, db })
    expect((await unseal("app:share", flip(link, index), { db }))[0]?.code).toBe("ENV_SEAL_INVALID")
    expect(await unseal("app:share", link, { db })).toEqual([undefined, { role: "member" }])
  })

  it("keeps the use when the value does not match the schema", async () => {
    const { db } = (await sharedDatabase())()
    const link = await seal("app:share", { role: "member" }, { uses: 1, db })
    expect((await unseal("app:share", link, { db, schema: v.object({ role: v.number() }) }))[0]?.code).toBe("ENV_SEAL_SCHEMA_MISMATCH")
    expect(await unseal("app:share", link, { db, schema: v.object({ role: v.string() }) })).toEqual([undefined, { role: "member" }])
  })

  it("throws ENV_SEAL_ARGUMENT_INVALID for uses without a db, and for a counted value read without one", async () => {
    const { db } = (await sharedDatabase())()
    await expect(seal("app:share", "hello", { uses: 1 })).rejects.toMatchObject({ code: "ENV_SEAL_ARGUMENT_INVALID" })
    for (const uses of [0, -1, 1.5, Number.NaN]) {
      await expect(seal("app:share", "hello", { uses, db })).rejects.toMatchObject({ code: "ENV_SEAL_ARGUMENT_INVALID" })
    }
    const link = await seal("app:share", "hello", { uses: 1, db })
    await expect(unseal("app:share", link)).rejects.toMatchObject({ code: "ENV_SEAL_ARGUMENT_INVALID" })
  })

  it("rejects an unauthenticated counted header without requiring a db", async () => {
    const sealed = await seal("app:share", { message: "a sufficiently long ordinary JSON payload" })
    const bytes = Buffer.from(sealed, "base64url")
    bytes[0] = 2
    expect((await unseal("app:share", bytes.toString("base64url")))[0]?.code).toBe("ENV_SEAL_INVALID")

    const { db } = (await sharedDatabase())()
    const counted = await seal("app:share", "hello", { uses: 1, db })
    expect((await unseal("app:share", flip(counted, 13)))[0]?.code).toBe("ENV_SEAL_INVALID")
  })

  it("still opens a value without uses any number of times, with or without a db", async () => {
    const { db } = (await sharedDatabase())()
    const sealed = await seal("app:share", "hello")
    expect(await unseal("app:share", sealed, { db })).toEqual([undefined, "hello"])
    expect(await unseal("app:share", sealed)).toEqual([undefined, "hello"])
  })
})

describe("seal with uses on D1", () => {
  it("takes each use once, also under concurrent reads", async () => {
    const worker = new Miniflare({
      compatibilityDate: "2026-07-30",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch: () => new Response() }",
    })
    cleanup.push(() => worker.dispose())
    const db = drizzleD1(await worker.getD1Database("DB"))
    const once = await seal("app:share", "hello", { uses: 1, db })
    expect(await unseal("app:share", once, { db })).toEqual([undefined, "hello"])
    expect((await unseal("app:share", once, { db }))[0]?.code).toBe("ENV_SEAL_USED_UP")

    const twice = await seal("app:share", "hello", { uses: 2, db })
    const results = await Promise.all([1, 2, 3, 4].map(() => unseal("app:share", twice, { db })))
    expect(results.filter(([error]) => !error)).toHaveLength(2)
    expect(results.filter(([error]) => error?.code === "ENV_SEAL_USED_UP")).toHaveLength(2)
  }, 30_000)
})
