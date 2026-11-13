import { createClient } from "@libsql/client"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { syncChanges, syncMutations, syncState, syncTables } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { createSyncHandler, handleSyncRequest, recordSyncChanges } from "../src/runtime.ts"

import type { DefineSyncOptions } from "../src/types.ts"
import type { SyncMutation, SyncPullResponse, SyncPushResponse } from "../src/protocol.ts"

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
})

type Todo = typeof todos.$inferSelect

const day = 86_400_000
const origin = "https://app.test"

async function setup(options: Partial<DefineSyncOptions<typeof todos>> = {}) {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(`${[
    ...syncTables,
    "CREATE TABLE `todos` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `title` text NOT NULL, `done` integer DEFAULT 0 NOT NULL)",
  ].join(";\n")};`)
  const db = drizzle({ client })
  const clock = { now: 1_000_000_000_000 }
  const definition = defineSync({ table: todos, where: ({ user }) => user ? { ownerId: user.id } : false, ...options })
  const services = {
    db,
    now: () => clock.now,
    identify: async (request: Request) => {
      const id = request.headers.get("x-user")
      return id ? { user: { id }, session: null } : null
    },
  }
  const call = (request: Request) => handleSyncRequest("todos", definition, request, services)

  async function pull(user: string | null, query: { cursor?: number, scope?: string } = {}) {
    const url = new URL("/api/_vitehub/sync/todos", origin)
    if (query.cursor !== undefined) url.searchParams.set("cursor", String(query.cursor))
    if (query.scope) url.searchParams.set("scope", query.scope)
    const response = await call(new Request(url, { headers: user ? { "x-user": user } : {} }))
    // SAFETY: the tests read the documented answer of a pull.
    return { status: response.status, headers: response.headers, body: await response.json() as SyncPullResponse & { code?: string } }
  }

  async function push(user: string, body: { scope: string, cursor?: number, mutations: SyncMutation[] }, headers: Record<string, string> = {}) {
    const response = await call(new Request(new URL("/api/_vitehub/sync/todos", origin), {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-user": user, ...headers },
      body: JSON.stringify(body),
    }))
    // SAFETY: the tests read the documented answer of a push.
    return { status: response.status, body: await response.json() as SyncPushResponse & { code?: string } }
  }

  /** The scope id and the cursor of a fresh pull. */
  async function start(user: string) {
    const { body } = await pull(user)
    return { scope: body.scope.id, cursor: body.cursor }
  }

  const rows = async () => await db.select().from(todos).orderBy(todos.id)
  return { client, db, clock, definition, services, pull, push, start, rows }
}

const insert = (id: string, value: Partial<Todo>): SyncMutation => ({ id, op: "insert", value })
const update = (id: string, key: string, patch: Partial<Todo>): SyncMutation => ({ id, op: "update", key, patch })
const remove = (id: string, key: string): SyncMutation => ({ id, op: "delete", key })

describe("pull", () => {
  it("returns only the caller's rows and a cursor on a reset pull", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    expect(alice.scope).not.toBe(bob.scope)
    expect(alice.scope).toMatch(/^[0-9a-f]{32}$/)
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", title: "Eggs" })] })
    await app.push("bob", { scope: bob.scope, mutations: [insert("m3", { id: "b1", title: "Secret" })] })

    const { status, headers, body } = await app.pull("alice")
    expect(status).toBe(200)
    expect(headers.get("cache-control")).toBe("private, no-store")
    expect(body).toMatchObject({ key: "id", scope: { id: alice.scope, values: { ownerId: "alice" } }, reset: true, deleted: [], more: false })
    expect(body.rows.map(row => row.id).sort()).toEqual(["a1", "a2"])
    expect(body.cursor).toBeGreaterThan(0)
  })

  it("returns only the changes after the cursor on an incremental pull", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const before = (await app.pull("alice")).body.cursor
    await app.push("bob", { scope: bob.scope, mutations: [insert("m2", { id: "b1", title: "Secret" })] })
    await app.push("alice", { scope: alice.scope, mutations: [insert("m3", { id: "a2", title: "Eggs" }), update("m4", "a1", { done: true })] })

    const { body } = await app.pull("alice", { cursor: before, scope: alice.scope })
    expect(body.reset).toBe(false)
    expect(body.rows).toEqual([{ id: "a2", ownerId: "alice", title: "Eggs", done: false }, { id: "a1", ownerId: "alice", title: "Milk", done: true }])
    expect(body.cursor).toBeGreaterThan(before)
    expect((await app.pull("alice", { cursor: body.cursor, scope: alice.scope })).body).toMatchObject({ reset: false, rows: [], deleted: [], cursor: body.cursor })
  })

  it("sends a delete only to the scope that owned the row", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const cursor = (await app.pull("alice")).body.cursor
    await app.push("alice", { scope: alice.scope, mutations: [remove("m2", "a1")] })

    expect((await app.pull("alice", { cursor, scope: alice.scope })).body).toMatchObject({ reset: false, rows: [], deleted: ["a1"] })
    expect((await app.pull("bob", { cursor, scope: bob.scope })).body).toMatchObject({ reset: false, rows: [], deleted: [] })
  })

  it("answers a changed scope or a cursor below the floor with a reset", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    expect((await app.pull("alice", { cursor: 0, scope: "an-old-scope" })).body.reset).toBe(true)
    // A cursor from another Database, newer than every change here.
    expect((await app.pull("alice", { cursor: 9999, scope: alice.scope })).body.reset).toBe(true)
  })

  it("refuses callers that `where` refuses", async () => {
    const app = await setup()
    expect(await app.pull(null)).toMatchObject({ status: 401, body: { code: "SYNC_UNAUTHORIZED" } })
    const closed = await setup({ where: () => false })
    expect(await closed.pull("alice")).toMatchObject({ status: 403, body: { code: "SYNC_FORBIDDEN" } })
  })

  it("reads 150 changed keys in one pull, and pages after 500 changes", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    for (let start = 0; start < 150; start += 100) {
      const mutations = Array.from({ length: Math.min(100, 150 - start) }, (_, index) => insert(`m${start + index}`, { id: `k${String(start + index).padStart(3, "0")}`, title: "x" }))
      const { body } = await app.push("alice", { scope: alice.scope, mutations })
      expect(body.results.every(result => result.status === "applied")).toBe(true)
    }
    const { body } = await app.pull("alice", { cursor: alice.cursor, scope: alice.scope })
    expect(body).toMatchObject({ reset: false, more: false })
    expect(body.rows).toHaveLength(150)

    // 520 rows that server code wrote, with a few of another owner in between.
    await app.db.insert(todos).values(Array.from({ length: 520 }, (_, index) => ({ id: `s${String(index).padStart(3, "0")}`, ownerId: index % 50 === 0 ? "bob" : "alice", title: "y" })))
    await createSyncHandler({ definitions: { todos: app.definition }, databases: { default: { db: app.db } } })
    const [error, recorded] = await recordSyncChanges("todos", { put: Array.from({ length: 520 }, (_, index) => `s${String(index).padStart(3, "0")}`) })
    expect(error).toBeUndefined()
    expect(recorded).toEqual({ recorded: 520 })
    const first = (await app.pull("alice", { cursor: body.cursor, scope: alice.scope })).body
    expect(first).toMatchObject({ reset: false, more: true })
    expect(first.rows).toHaveLength(500 - 10)
    const second = (await app.pull("alice", { cursor: first.cursor, scope: alice.scope })).body
    expect(second).toMatchObject({ reset: false, more: false })
    expect(second.rows).toHaveLength(20 - 1)
    expect(new Set([...first.rows, ...second.rows].map(row => row.ownerId))).toEqual(new Set(["alice"]))
  })

  it("shows writes that server code recorded with recordSyncChanges()", async () => {
    const app = await setup()
    createSyncHandler({ definitions: { todos: app.definition }, databases: { default: { db: app.db } } })
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.db.insert(todos).values({ id: "srv", ownerId: "alice", title: "From the server" })
    expect(await recordSyncChanges("todos", { put: ["srv"] })).toEqual([undefined, { recorded: 1 }])
    const added = (await app.pull("alice", { cursor: alice.cursor, scope: alice.scope })).body
    expect(added.rows).toEqual([{ id: "srv", ownerId: "alice", title: "From the server", done: false }])

    const [row] = await app.db.delete(todos).where(eq(todos.id, "srv")).returning()
    expect(await recordSyncChanges("todos", { delete: [row!] })).toEqual([undefined, { recorded: 1 }])
    expect((await app.pull("alice", { cursor: added.cursor, scope: alice.scope })).body).toMatchObject({ rows: [], deleted: ["srv"] })
    expect((await app.pull("bob", { cursor: bob.cursor, scope: bob.scope })).body).toMatchObject({ rows: [], deleted: [] })

    const [unknown] = await recordSyncChanges("nope", { put: ["x"] })
    expect(unknown?.code).toBe("SYNC_UNKNOWN_NAME")
  })
})

describe("push", () => {
  it("stamps the scope values on insert, and refuses other values", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", ownerId: "bob", title: "Planted" })] })
    expect(body.results[0]).toEqual({ id: "m1", status: "applied" })
    expect(body.results[1]).toMatchObject({ id: "m2", status: "rejected", error: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
    expect(body.pull.rows).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
  })

  it("refuses an update that would move a row out of the scope", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const { body } = await app.push("alice", { scope: alice.scope, mutations: [update("m2", "a1", { ownerId: "bob" }), update("m3", "a1", { ownerId: "alice", title: "Oat milk" })] })
    expect(body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(body.results[1]).toEqual({ id: "m3", status: "applied" })
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Oat milk", done: false }])
  })

  it("refuses unknown columns, a changed primary key, and a missing key", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const { body } = await app.push("alice", {
      scope: alice.scope,
      mutations: [
        { id: "m2", op: "insert", value: { id: "a2", title: "x", color: "red" } },
        update("m3", "a1", { id: "a9" }),
        { id: "m4", op: "insert", value: { title: "No key" } },
      ],
    })
    expect(body.results.map(result => result.status === "rejected" ? result.error.code : result.status)).toEqual(["SYNC_INVALID", "SYNC_INVALID", "SYNC_INVALID"])
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
  })

  it("applies a mutation id once, so a retry after a lost answer is a duplicate", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const first = await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { title: "Oat milk" })] })
    expect(first.body.results.map(result => result.status)).toEqual(["applied", "applied"])
    await app.push("alice", { scope: alice.scope, mutations: [update("m3", "a1", { title: "Soy milk" })] })
    // The first push again, as a client does when it never got the answer.
    const retry = await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { title: "Oat milk" })] })
    expect(retry.status).toBe(200)
    expect(retry.body.results).toEqual([{ id: "m1", status: "duplicate" }, { id: "m2", status: "duplicate" }])
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Soy milk", done: false }])
  })

  it("applies an insert and an update of one push in order", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { scope: alice.scope, cursor: alice.cursor, mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { done: true }), remove("m3", "a1"), insert("m4", { id: "a2", title: "Eggs" })] })
    expect(body.results.map(result => result.status)).toEqual(["applied", "applied", "applied", "applied"])
    expect(await app.rows()).toEqual([{ id: "a2", ownerId: "alice", title: "Eggs", done: false }])
    expect(body.pull).toMatchObject({ reset: false, rows: [{ id: "a2" }], deleted: ["a1"] })
  })

  it("writes nothing for a push of an old scope", async () => {
    const app = await setup()
    const bob = await app.start("bob")
    // Writes that a client queued while Bob was signed in, sent after Alice signed in.
    const { status, body } = await app.push("alice", { scope: bob.scope, mutations: [insert("m1", { id: "b1", title: "Bob's note" })] })
    expect(status).toBe(409)
    expect(body.code).toBe("SYNC_SCOPE_CHANGED")
    expect(await app.rows()).toEqual([])
    expect(await app.db.select().from(syncMutations)).toEqual([])
    expect(await app.db.select().from(syncChanges)).toEqual([])
  })

  it("keeps other scopes' rows out of reach", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.push("bob", { scope: bob.scope, mutations: [insert("m1", { id: "b1", title: "Bob's" })] })
    const { body } = await app.push("alice", { scope: alice.scope, mutations: [update("m2", "b1", { title: "Mine" }), remove("m3", "b1"), insert("m4", { id: "b1", title: "Take over" })] })
    expect(body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_NOT_FOUND" } })
    // A delete of a row that the caller cannot see changes nothing, like a delete of a missing row.
    expect(body.results[1]).toEqual({ id: "m3", status: "applied" })
    expect(body.results[2]).toMatchObject({ status: "rejected", error: { code: "SYNC_KEY_EXISTS" } })
    expect(await app.rows()).toEqual([{ id: "b1", ownerId: "bob", title: "Bob's", done: false }])
  })

  it("checks `write`, `schema`, and read-only definitions", async () => {
    const readOnly = await setup({ write: false })
    const scope = (await readOnly.start("alice")).scope
    expect((await readOnly.push("alice", { scope, mutations: [insert("m1", { id: "a1", title: "x" })] })).body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_READ_ONLY" } })

    const checked = await setup({
      write: ({ op, row }) => op !== "delete" && row.title !== "forbidden",
      schema: v.object({ title: v.pipe(v.string(), v.minLength(2, "Write a longer title.")) }),
    })
    const own = (await checked.start("alice")).scope
    const { body } = await checked.push("alice", { scope: own, mutations: [insert("m1", { id: "a1", title: "ok" }), insert("m2", { id: "a2", title: "x" }), insert("m3", { id: "a3", title: "forbidden" }), remove("m4", "a1")] })
    expect(body.results[0]).toEqual({ id: "m1", status: "applied" })
    expect(body.results[1]).toMatchObject({ status: "rejected", error: { code: "SYNC_INVALID", issues: [{ path: "title", message: "Write a longer title." }] } })
    expect(body.results[2]).toMatchObject({ status: "rejected", error: { code: "SYNC_FORBIDDEN" } })
    expect(body.results[3]).toMatchObject({ status: "rejected", error: { code: "SYNC_FORBIDDEN" } })
    expect((await checked.rows()).map(row => row.id)).toEqual(["a1"])
  })

  it("refuses cross-site, oversized, and malformed pushes", async () => {
    const app = await setup()
    const { scope } = await app.start("alice")
    const one = [insert("m1", { id: "a1", title: "x" })]
    expect(await app.push("alice", { scope, mutations: one }, { origin: "https://evil.test" })).toMatchObject({ status: 403, body: { code: "SYNC_FORBIDDEN" } })
    expect(await app.push("alice", { scope, mutations: Array.from({ length: 101 }, (_, index) => insert(`m${index}`, { id: `k${index}`, title: "x" })) })).toMatchObject({ status: 413, body: { code: "SYNC_TOO_MANY_MUTATIONS" } })
    expect(await app.push("alice", { scope, mutations: [insert("m1", { id: "a1", title: "x".repeat(1024 * 1024) })] })).toMatchObject({ status: 413, body: { code: "SYNC_BAD_REQUEST" } })
    expect(await app.push("alice", { scope, mutations: [{ id: "m1", op: "upsert" } as never] })).toMatchObject({ status: 400, body: { code: "SYNC_BAD_REQUEST" } })
    expect(await app.rows()).toEqual([])
  })

  it("compacts old deletes, raises the floor, and resets older cursors", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { scope: alice.scope, mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", title: "Eggs" })] })
    const old = (await app.pull("alice")).body.cursor
    await app.push("alice", { scope: alice.scope, mutations: [remove("m3", "a1")] })
    const current = (await app.pull("alice")).body.cursor

    app.clock.now += 31 * day
    await app.push("alice", { scope: alice.scope, mutations: [update("m4", "a2", { done: true })] })
    const [state] = await app.db.select().from(syncState)
    expect(state).toEqual({ name: "todos", floor: current })
    expect(await app.db.select().from(syncChanges).where(eq(syncChanges.op, "delete"))).toEqual([])
    expect((await app.db.select().from(syncMutations)).map(row => row.id)).toEqual(["m4"])

    expect((await app.pull("alice", { cursor: old, scope: alice.scope })).body).toMatchObject({ reset: true, rows: [{ id: "a2", done: true }] })
    // A client that saw the removed delete keeps pulling incrementally.
    expect((await app.pull("alice", { cursor: current, scope: alice.scope })).body).toMatchObject({ reset: false, rows: [{ id: "a2", done: true }] })
  })
})
