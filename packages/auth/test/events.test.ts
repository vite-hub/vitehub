import { afterEach, describe, expect, it, vi } from "vitest"
import { createDatabaseAuthEventStore, defaultAuthEventRetention } from "../src/events.ts"
import { authEventDevice } from "../src/event-plugin.ts"
import { eventDatabase } from "./event-helpers.ts"
import type { AuthEvent } from "../src/events.ts"

const databases: ReturnType<typeof eventDatabase>[] = []
function database() { const db = eventDatabase(); databases.push(db); return db }
afterEach(() => { databases.splice(0).forEach(db => db.sqlite.close()); vi.restoreAllMocks(); vi.useRealTimers() })
function event(id: string, time = "2026-10-20T10:00:00.000Z", userId = "u1"): AuthEvent {
  return { id, type: "user.signed_in", time, actor: `user:${userId}`, userId, metadata: { method: "email-password" } }
}
const window = { from: "2026-10-20T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" }

describe("auth event SQLite store", () => {
  it("persists safe fields, strips extra data, and survives a new store instance", async () => {
    const { db, sqlite } = database()
    const store = createDatabaseAuthEventStore({ db, retention: false })
    await store.append({ ...event("1"), token: "session-secret", metadata: { method: "email-password", password: "password-secret", ip: "192.0.2.42", userAgent: "full-agent" } } as AuthEvent)
    const reopened = createDatabaseAuthEventStore({ db, retention: false })
    expect((await reopened.list()).events).toEqual([event("1")])
    expect(JSON.stringify(sqlite.prepare("SELECT * FROM vitehub_auth_events").all())).not.toMatch(/session-secret|password-secret|192\.0\.2|full-agent/)
  })
  it("filters in SQL and paginates equal timestamps without repeats, even if the cursor row is removed", async () => {
    const { db, sqlite, queries } = database()
    const store = createDatabaseAuthEventStore({ db, retention: false })
    for (const item of [event("a"), event("b"), event("c"), event("d", undefined, "u2")]) await store.append(item)
    const first = await store.list({ userId: "u1", actor: "user:u1", type: "user.signed_in", ...window, limit: 2 })
    expect(first.events.map(row => row.id)).toEqual(["c", "b"])
    sqlite.prepare("DELETE FROM vitehub_auth_events WHERE id = 'b'").run()
    queries.length = 0
    const second = await store.list({ userId: "u1", cursor: first.nextCursor, limit: 2 })
    expect(second.events.map(row => row.id)).toEqual(["a"])
    expect(second.nextCursor).toBeUndefined()
    expect(queries).toHaveLength(1)
    expect((await store.list({ to: "2026-10-20T10:00:00.000Z" })).events).toEqual([])
    expect((await store.list({ from: "2026-10-20T10:00:00.000Z" })).events).toHaveLength(3)
    expect((await store.list({ actor: "user:' OR 1=1 --" })).events).toEqual([])
  })
  it("aggregates daily and window-distinct users in two queries and zero-fills days", async () => {
    const { db, queries } = database()
    const store = createDatabaseAuthEventStore({ db, retention: false })
    for (const item of [
      { ...event("a"), type: "user.signed_up" as const }, event("b"), event("c"),
      { ...event("d", "2026-10-21T10:00:00.000Z"), metadata: { method: "oauth:github" } },
      event("e", "2026-10-21T10:00:00.000Z", "u2"),
      { ...event("f"), type: "impersonation.started" as const },
      event("outside", window.to),
    ]) await store.append(item)
    queries.length = 0
    const result = await store.aggregate(window)
    expect(queries).toHaveLength(2)
    expect(result.totals).toEqual({ signUps: 1, signIns: 4, activeUsers: 2, methods: { "email-password": 3, "oauth:github": 1 } })
    expect(result.days.map(day => day.activeUsers)).toEqual([1, 2, 0])
    expect(result.days[2]).toEqual({ day: "2026-10-22", signUps: 0, signIns: 0, activeUsers: 0, methods: {} })
  })
  it("enforces retention by age and count on writes and hides expired rows on reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T10:00:00Z"))
    const { db, sqlite } = database()
    const store = createDatabaseAuthEventStore({ db, retention: { maxAgeMs: 86400_000, maxRecords: 2 } })
    for (const id of ["a", "b", "c"]) await store.append(event(id))
    expect((await store.list()).events.map(item => item.id)).toEqual(["c", "b"])
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"))
    expect((await store.list()).events).toEqual([])
    expect((await store.aggregate(window)).totals.activeUsers).toBe(0)
    await store.append(event("d", new Date().toISOString()))
    expect(sqlite.prepare("SELECT id FROM vitehub_auth_events").all()).toEqual([{ id: "d" }])
    expect(defaultAuthEventRetention).toEqual({ maxAgeMs: 90 * 86400_000, maxRecords: 100_000 })
  })
  it("rejects invalid filters and limits, deduplicates ids, and retries failed initialization", async () => {
    const { db } = database()
    let fail = true
    const store = createDatabaseAuthEventStore({ db: { ...db, run(query) { if (fail) { fail = false; throw new Error("offline") }; return db.run(query) } }, retention: false })
    await expect(store.list()).rejects.toThrow("offline")
    await store.append(event("a")); await store.append(event("a"))
    expect((await store.list()).events).toHaveLength(1)
    for (const limit of [0, -1, 201, NaN]) await expect(store.list({ limit })).rejects.toThrow()
    await expect(store.list({ cursor: "bad" })).rejects.toThrow()
    await expect(store.aggregate({ from: window.to, to: window.from })).rejects.toThrow()
    expect(() => createDatabaseAuthEventStore({ db, retention: { maxRecords: 0 } })).toThrow()
  })
  it("reduces user agents to a coarse device", () => {
    expect(["Mozilla iPhone Mobile", "Mozilla iPad", "Android tablet", "Mozilla Macintosh", "Googlebot", "opaque", null].map(authEventDevice)).toEqual(["mobile", "tablet", "tablet", "desktop", "bot", "unknown", "unknown"])
  })
})
