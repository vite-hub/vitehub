import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { describe, expect, it } from "vitest"

import { createDatabaseConnectionStore } from "../src/store.ts"

describe("stored Connection scopes", () => {
  it("rejects corrupt scopes instead of reporting a partial grant", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      const db = drizzle(client)
      const store = createDatabaseConnectionStore({ db, encryptionKey: new Uint8Array(32).fill(9) })
      await store.state.put({ name: "mail", scopes: ["mail.read"], status: "connected", updatedAt: "2026-09-30T00:00:00Z" })
      expect((await store.state.get("mail"))?.scopes).toEqual(["mail.read"])
      for (const scopes of ['["mail.read", 42]', '{}', 'null']) {
        await db.run(sql`UPDATE vitehub_connection_state SET scopes = ${scopes} WHERE name = 'mail'`)
        await expect(store.state.get("mail")).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
      }
    }
    finally {
      client.close()
    }
  })
})

describe("approval execution leases", () => {
  it("reports matched and lost leases through the D1 Drizzle adapter", async () => {
    const worker = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
    })
    try {
      const db = drizzleD1(await worker.getD1Database("DB"))
      const store = createDatabaseConnectionStore({ db, encryptionKey: new Uint8Array(32).fill(9) })
      await store.approvals.create({ id: "d1", name: "mail", actor: "agent:test", action: "mail.write", input: {}, status: "pending", createdAt: "2026-09-30T00:00:00.000Z" })
      expect(await store.approvals.renew("d1", "2026-09-30T00:10:00.000Z")).toBe(false)
      expect(await store.approvals.transition("d1", "pending", "approved", { executionExpiresAt: "2026-09-30T00:05:00.000Z" })).toMatchObject({ status: "approved" })
      expect(await store.approvals.renew("d1", "2026-09-30T00:10:00.000Z")).toBe(true)
      await store.approvals.recover("2026-09-30T00:06:00.000Z")
      expect(await store.approvals.get("d1")).toMatchObject({ status: "approved" })
      await store.approvals.recover("2026-09-30T00:10:00.000Z")
      expect(await store.approvals.renew("d1", "2026-09-30T00:20:00.000Z")).toBe(false)
      expect(await store.approvals.transition("d1", "approved", "executed")).toBeUndefined()
      expect(await store.approvals.renew("missing", "2026-09-30T00:20:00.000Z")).toBe(false)
    }
    finally {
      await worker.dispose()
    }
  }, 30_000)

  it("adds leases to an existing approvals table and only renews active executions", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      const db = drizzle(client)
      await db.run(
        sql`CREATE TABLE vitehub_connection_approvals (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, trace_id TEXT, invocation_id TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT, error TEXT)`,
      )
      const store = createDatabaseConnectionStore({
        db,
        encryptionKey: new Uint8Array(32).fill(9),
      })
      await store.approvals.create({
        id: "a1",
        name: "mail",
        actor: "agent:test",
        action: "mail.write",
        input: {},
        status: "pending",
        createdAt: "2026-09-30T00:00:00.000Z",
      })
      await store.approvals.transition("a1", "pending", "approved", {
        decidedAt: "2026-09-30T00:00:00.000Z",
        executionExpiresAt: "2026-09-30T00:05:00.000Z",
      })
      await store.approvals.renew("a1", "2026-09-30T00:10:00.000Z")
      await store.approvals.recover("2026-09-30T00:06:00.000Z")
      expect(await store.approvals.get("a1")).toMatchObject({
        status: "approved",
        decidedAt: "2026-09-30T00:00:00.000Z",
      })
      await store.approvals.recover("2026-09-30T00:10:00.000Z")
      expect(await store.approvals.get("a1")).toMatchObject({
        status: "failed",
        error: "CONNECTION_EXECUTION_UNKNOWN",
      })
      await store.approvals.renew("a1", "2026-09-30T00:20:00.000Z")
      expect(
        await db.all(
          sql`SELECT execution_expires_at FROM vitehub_connection_approvals WHERE id = 'a1'`,
        ),
      ).toEqual([{ execution_expires_at: "2026-09-30T00:10:00.000Z" }])
    } finally {
      client.close()
    }
  })
})

it("updates Connection metadata atomically at the token revision", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    const store = createDatabaseConnectionStore({ db: drizzle(client), encryptionKey: new Uint8Array(32).fill(9) })
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
  finally { client.close() }
})

it.each(["pending", "executed"] as const)("paginates %s approvals without skipping or repeating entries", async (status) => {
  const client = createClient({ url: ":memory:" })
  try {
    const store = createDatabaseConnectionStore({ db: drizzle(client), encryptionKey: new Uint8Array(32).fill(9) })
    for (let index = 0; index < 205; index++) {
      await store.approvals.create({
        id: `approval-${index}`,
        name: "mail",
        actor: "agent:test",
        action: "mail.write",
        input: {},
        status,
        createdAt: "2026-09-30T00:00:00.000Z",
      })
    }
    await store.approvals.create({ id: "other-connection", name: "calendar", actor: "agent:test", action: "calendar.write", input: {}, status, createdAt: "2026-09-30T00:00:00.000Z" })
    const first = await store.approvals.list({ name: "mail", status })
    expect(first.approvals.map(approval => approval.id)).toEqual(Array.from({ length: 100 }, (_, index) => `approval-${204 - index}`))
    expect(first.nextCursor).toBe("approval-105")
    const second = await store.approvals.list({ name: "mail", status, before: first.nextCursor })
    expect(second.approvals.map(approval => approval.id)).toEqual(Array.from({ length: 100 }, (_, index) => `approval-${104 - index}`))
    expect(second.nextCursor).toBe("approval-5")
    const last = await store.approvals.list({ name: "mail", status, before: second.nextCursor })
    expect(last.approvals.map(approval => approval.id)).toEqual(["approval-4", "approval-3", "approval-2", "approval-1", "approval-0"])
    expect(last.nextCursor).toBeUndefined()
    if (status === "pending") expect(await store.approvals.pendingCounts(["mail", "calendar"])).toEqual({ mail: 205, calendar: 1 })
  }
  finally {
    client.close()
  }
})
