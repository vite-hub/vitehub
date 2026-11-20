import { eq } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import * as v from "valibot"
import { describe, expect, it } from "vitest"

import { syncChanges, syncMutations, syncState } from "../src/database.ts"
import { defineSync } from "../src/define.ts"
import { createHarness, day } from "./handler-harness.ts"

import type { DefineSyncOptions } from "../src/types.ts"
import type { SyncMutation } from "../src/protocol.ts"

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
})

type Todo = typeof todos.$inferSelect

async function setup(options: Partial<DefineSyncOptions<typeof todos>> = {}) {
  const definition = defineSync({ table: todos, where: ({ user }) => user ? { ownerId: user.id } : false, ...options })
  const harness = await createHarness({
    name: "todos",
    definition,
    ddl: ["CREATE TABLE `todos` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `title` text NOT NULL, `done` integer DEFAULT 0 NOT NULL)"],
  })
  const rows = async () => await harness.db.select().from(todos).orderBy(todos.id)
  return { ...harness, definition, rows }
}

const insert = (id: string, value: Partial<Todo>): SyncMutation => ({ id, op: "insert", value })
const update = (id: string, key: string, patch: Partial<Todo>): SyncMutation => ({ id, op: "update", key, patch })
const remove = (id: string, key: string): SyncMutation => ({ id, op: "delete", key })
/** The fields of a held pull that a push or an incremental pull sends. */
const as = (held: { scope: string, version: string, account: string }) => ({ scope: held.scope, version: held.version, account: held.account })

describe("pull", () => {
  it("returns only the caller's rows and a cursor on a reset pull", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    expect(alice.scope).not.toBe(bob.scope)
    expect(alice.scope).toMatch(/^[0-9a-f]{32}$/)
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", title: "Eggs" })] })
    await app.push("bob", { ...as(bob), mutations: [insert("m3", { id: "b1", title: "Secret" })] })

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
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const before = (await app.pull("alice")).body.cursor
    await app.push("bob", { ...as(bob), mutations: [insert("m2", { id: "b1", title: "Secret" })] })
    await app.push("alice", { ...as(alice), mutations: [insert("m3", { id: "a2", title: "Eggs" }), update("m4", "a1", { done: true })] })

    const { body } = await app.pull("alice", { cursor: before, ...as(alice) })
    expect(body.reset).toBe(false)
    expect(body.rows).toEqual([{ id: "a2", ownerId: "alice", title: "Eggs", done: false }, { id: "a1", ownerId: "alice", title: "Milk", done: true }])
    expect(body.cursor).toBeGreaterThan(before)
    expect((await app.pull("alice", { cursor: body.cursor, ...as(alice) })).body).toMatchObject({ reset: false, rows: [], deleted: [], cursor: body.cursor })
  })

  it("sends a delete only to the scope that owned the row", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const cursor = (await app.pull("alice")).body.cursor
    await app.push("alice", { ...as(alice), mutations: [remove("m2", "a1")] })

    expect((await app.pull("alice", { cursor, ...as(alice) })).body).toMatchObject({ reset: false, rows: [], deleted: ["a1"] })
    expect((await app.pull("bob", { cursor, ...as(bob) })).body).toMatchObject({ reset: false, rows: [], deleted: [] })
  })

  it("answers a changed scope or a cursor below the floor with a reset", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    expect((await app.pull("alice", { ...as(alice), cursor: 0, scope: "an-old-scope" })).body.reset).toBe(true)
    // A cursor from another Database, newer than every change here.
    expect((await app.pull("alice", { cursor: 9999, ...as(alice) })).body.reset).toBe(true)
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
    let queue = Array.from({ length: 150 }, (_, index) => insert(`m${index}`, { id: `k${String(index).padStart(3, "0")}`, title: "x" }))
    while (queue.length) {
      const { body } = await app.push("alice", { ...as(alice), mutations: queue.slice(0, 100) })
      expect(body.results.every(result => result.status === "applied")).toBe(true)
      queue = queue.slice(body.results.length)
    }
    const { body } = await app.pull("alice", { cursor: alice.cursor, ...as(alice) })
    expect(body).toMatchObject({ reset: false, more: false })
    expect(body.rows).toHaveLength(150)

    // 520 rows that server code wrote, with a few of another owner in between.
    await app.db.insert(todos).values(Array.from({ length: 520 }, (_, index) => ({ id: `s${String(index).padStart(3, "0")}`, ownerId: index % 50 === 0 ? "bob" : "alice", title: "y" })))
    const first = (await app.pull("alice", { cursor: body.cursor, ...as(alice) })).body
    expect(first).toMatchObject({ reset: false, more: true })
    expect(first.rows).toHaveLength(500 - 10)
    const second = (await app.pull("alice", { cursor: first.cursor, ...as(alice) })).body
    expect(second).toMatchObject({ reset: false, more: false })
    expect(second.rows).toHaveLength(20 - 1)
    expect(new Set([...first.rows, ...second.rows].map(row => row.ownerId))).toEqual(new Set(["alice"]))
  })

  it("sends a snapshot of 1200 rows in pages of 500 by key, and the rows that changed meanwhile with the next pull", async () => {
    const app = await setup()
    await app.db.insert(todos).values(Array.from({ length: 1200 }, (_, index) => ({ id: `r${String(index).padStart(4, "0")}`, ownerId: index % 100 === 0 ? "bob" : "alice", title: "old" })))
    const copy = new Map<string, Todo>()
    const first = (await app.pull("alice", { paged: true })).body
    expect(first).toMatchObject({ reset: true, more: true, after: "r0505" })
    expect(first.rows).toHaveLength(500)
    for (const row of first.rows) copy.set(String(row.id), row as Todo)

    await app.db.update(todos).set({ title: "changed" }).where(eq(todos.id, "r0001"))
    await app.db.delete(todos).where(eq(todos.id, "r0002"))
    await app.db.delete(todos).where(eq(todos.id, "r0901"))
    const held = { cursor: first.cursor, scope: first.scope.id, version: first.version, paged: true }
    const second = (await app.pull("alice", { ...held, after: first.after! })).body
    expect(second).toMatchObject({ reset: false, cursor: first.cursor, more: true, after: "r1011" })
    expect(second.rows).toHaveLength(500)
    const third = (await app.pull("alice", { ...held, after: second.after! })).body
    expect(third).toMatchObject({ reset: false, cursor: first.cursor, more: true, after: null })
    expect(third.rows.length).toBeLessThan(500)
    for (const row of [...second.rows, ...third.rows]) copy.set(String(row.id), row as Todo)

    const changes = (await app.pull("alice", { ...held, paged: false })).body
    expect(changes).toMatchObject({ reset: false, more: false })
    for (const row of changes.rows) copy.set(String(row.id), row as Todo)
    for (const key of changes.deleted) copy.delete(key)
    expect([...copy.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual((await app.rows()).filter(row => row.ownerId === "alice"))
    expect(copy.get("r0001")?.title).toBe("changed")
  })

  it("shows writes that server code makes with Drizzle", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.db.insert(todos).values({ id: "srv", ownerId: "alice", title: "From the server" })
    const added = (await app.pull("alice", { cursor: alice.cursor, ...as(alice) })).body
    expect(added.rows).toEqual([{ id: "srv", ownerId: "alice", title: "From the server", done: false }])

    await app.db.delete(todos).where(eq(todos.id, "srv"))
    expect((await app.pull("alice", { cursor: added.cursor, ...as(alice) })).body).toMatchObject({ rows: [], deleted: ["srv"] })
    expect((await app.pull("bob", { cursor: bob.cursor, ...as(bob) })).body).toMatchObject({ rows: [], deleted: [] })
  })
})

describe("push", () => {
  it("stamps the scope values on insert, and refuses other values", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", ownerId: "bob", title: "Planted" })] })
    expect(body.results[0]).toEqual({ id: "m1", status: "applied" })
    expect(body.results[1]).toMatchObject({ id: "m2", status: "rejected", error: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
    expect(body.pull.rows).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
  })

  it("refuses an update that would move a row out of the scope", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const { body } = await app.push("alice", { ...as(alice), mutations: [update("m2", "a1", { ownerId: "bob" }), update("m3", "a1", { ownerId: "alice", title: "Oat milk" })] })
    expect(body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_OUT_OF_SCOPE" } })
    expect(body.results[1]).toEqual({ id: "m3", status: "applied" })
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Oat milk", done: false }])
  })

  it("refuses unknown columns, a changed primary key, and a missing key", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" })] })
    const { body } = await app.push("alice", {
      ...as(alice),
      mutations: [
        { id: "m2", op: "insert", value: { id: "a2", title: "x", color: "red" } },
        update("m3", "a1", { id: "a9" }),
        { id: "m4", op: "insert", value: { title: "No key" } },
      ],
    })
    expect(body.results.map(result => result.status === "rejected" ? result.error.code : result.status)).toEqual(["SYNC_INVALID", "SYNC_INVALID", "SYNC_INVALID"])
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Milk", done: false }])
  })

  it("rejects a row that the Database refuses, and applies the next mutations", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { status, body } = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "bad" }), insert("m2", { id: "good", title: "ok" })] })
    expect(status).toBe(200)
    expect(body.results[0]).toMatchObject({ id: "m1", status: "rejected", error: { code: "SYNC_INVALID", message: expect.stringContaining("NOT NULL") } })
    expect(body.results[1]).toEqual({ id: "m2", status: "applied" })
    expect(await app.rows()).toEqual([{ id: "good", ownerId: "alice", title: "ok", done: false }])
  })

  it("checks a write again when a write at the same time changed the row that `write` saw", async () => {
    // Two updates that each pass alone, and fail together: a locked title on a done row.
    let waiting: (() => void)[] = []
    let hold = true
    const app = await setup({
      write: async ({ row }) => {
        if (hold) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve)
            if (waiting.length === 2) {
              for (const release of waiting) release()
              waiting = []
              hold = false
            }
          })
        }
        return !(row.title === "locked" && row.done)
      },
    })
    const alice = await app.start("alice")
    hold = false
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "open" })] })
    hold = true
    const [first, second] = await Promise.all([
      app.push("alice", { ...as(alice), mutations: [update("m2", "a1", { title: "locked" })] }),
      app.push("alice", { ...as(alice), mutations: [update("m3", "a1", { done: true })] }),
    ])
    const statuses = [first.body.results[0]!.status, second.body.results[0]!.status].sort()
    expect(statuses).toEqual(["applied", "rejected"])
    const [row] = await app.rows()
    expect(row!.title === "locked" && row!.done).toBe(false)
  })

  it("applies a mutation id once, so a retry after a lost answer is a duplicate", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const first = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { title: "Oat milk" })] })
    expect(first.body.results.map(result => result.status)).toEqual(["applied", "applied"])
    await app.push("alice", { ...as(alice), mutations: [update("m3", "a1", { title: "Soy milk" })] })
    // The first push again, as a client does when it never got the answer.
    const retry = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { title: "Oat milk" })] })
    expect(retry.status).toBe(200)
    expect(retry.body.results).toEqual([{ id: "m1", status: "duplicate" }, { id: "m2", status: "duplicate" }])
    expect(await app.rows()).toEqual([{ id: "a1", ownerId: "alice", title: "Soy milk", done: false }])
  })

  it("drains 100 writes in pushes of at most 40 Database calls, the limit of the Workers Free plan being 50", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    let queue = Array.from({ length: 100 }, (_, index) => insert(`m${index}`, { id: `a${index}`, title: `Card ${index}` }))
    const calls: number[] = []
    while (queue.length && calls.length < 20) {
      const before = app.calls()
      const { status, body } = await app.push("alice", { ...as(alice), mutations: queue })
      calls.push(app.calls() - before)
      expect(status).toBe(200)
      expect(body.results.map(result => result.id)).toEqual(queue.slice(0, body.results.length).map(mutation => mutation.id))
      expect(body.results.every(result => result.status === "applied")).toBe(true)
      queue = queue.slice(body.results.length)
    }
    expect(queue).toEqual([])
    expect(Math.max(...calls)).toBeLessThanOrEqual(40)
    expect(await app.rows()).toHaveLength(100)
    const before = app.calls()
    const retried = await app.push("alice", { ...as(alice), mutations: Array.from({ length: 100 }, (_, index) => insert(`m${index}`, { id: `a${index}`, title: `Card ${index}` })) })
    expect(retried.body.results).toHaveLength(100)
    expect(retried.body.results.every(result => result.status === "duplicate")).toBe(true)
    expect(app.calls() - before).toBeLessThanOrEqual(5)
  })

  it("keeps a push of refused updates and an action that reads 16 rows under 40 Database calls", async () => {
    const app = await setup({
      actions: {
        read: async ({ get }, { ids }: { ids: string[] }) => {
          for (const id of ids) await get(id)
          return ids.length
        },
      },
    })
    const alice = await app.start("alice")
    let queue: SyncMutation[] = [
      ...Array.from({ length: 33 }, (_, index) => update(`u${index}`, `gone${index}`, { title: "x" })),
      { id: "a1", op: "action", name: "read", args: { ids: Array.from({ length: 16 }, (_, index) => `k${index}`) } },
    ]
    const calls: number[] = []
    const results: string[] = []
    while (queue.length && calls.length < 10) {
      const before = app.calls()
      const { status, body } = await app.push("alice", { ...as(alice), mutations: queue })
      calls.push(app.calls() - before)
      expect(status).toBe(200)
      results.push(...body.results.map(result => result.status))
      queue = queue.slice(body.results.length)
    }
    expect(queue).toEqual([])
    expect(Math.max(...calls)).toBeLessThanOrEqual(40)
    expect(results).toEqual([...Array.from({ length: 33 }, () => "rejected"), "applied"])
  })

  it("answers `duplicate` for an id that the same push applied before", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m1", { id: "a1", title: "Milk" })] })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }, { id: "m1", status: "duplicate" }])
  })

  it("answers `duplicate` when another push applies an insert after the ledger read", async () => {
    let retry: (() => Promise<void>) | undefined
    const app = await setup({ actions: { retry: async () => await retry?.() } })
    const alice = await app.start("alice")
    const write = insert("m1", { id: "a1", title: "Milk" })
    retry = async () => {
      const { body } = await app.push("alice", { ...as(alice), mutations: [write] })
      expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    }

    const { body } = await app.push("alice", { ...as(alice), mutations: [{ id: "race", op: "action", name: "retry" }, write] })
    expect(body.results).toEqual([{ id: "race", status: "applied" }, { id: "m1", status: "duplicate" }])
  })

  it("applies the first mutation of a push also when it passes `push.calls`", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", title: "Eggs" })] }, {}, { push: { calls: 1 } })
    expect(body.results).toEqual([{ id: "m1", status: "applied" }])
    expect((await app.rows()).map(row => row.id)).toEqual(["a1"])
  })

  it("applies an insert and an update of one push in order", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const { body } = await app.push("alice", { ...as(alice), cursor: alice.cursor, mutations: [insert("m1", { id: "a1", title: "Milk" }), update("m2", "a1", { done: true }), remove("m3", "a1"), insert("m4", { id: "a2", title: "Eggs" })] })
    expect(body.results.map(result => result.status)).toEqual(["applied", "applied", "applied", "applied"])
    expect(await app.rows()).toEqual([{ id: "a2", ownerId: "alice", title: "Eggs", done: false }])
    expect(body.pull).toMatchObject({ reset: false, rows: [{ id: "a2" }], deleted: ["a1"] })
  })

  it("writes nothing for a push of another account", async () => {
    const app = await setup()
    const bob = await app.start("bob")
    // Writes that a client queued while Bob was signed in, sent after Alice signed in.
    const { status, body } = await app.push("alice", { ...as(bob), mutations: [insert("m1", { id: "b1", title: "Bob's note" })] })
    expect(status).toBe(409)
    expect(body.code).toBe("SYNC_ACCOUNT_CHANGED")
    expect(await app.rows()).toEqual([])
    expect(await app.db.select().from(syncMutations)).toEqual([])
    expect(await app.db.select().from(syncChanges)).toEqual([])
  })

  it("keeps other scopes' rows out of reach", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    const bob = await app.start("bob")
    await app.push("bob", { ...as(bob), mutations: [insert("m1", { id: "b1", title: "Bob's" })] })
    const { body } = await app.push("alice", { ...as(alice), mutations: [update("m2", "b1", { title: "Mine" }), remove("m3", "b1"), insert("m4", { id: "b1", title: "Take over" })] })
    expect(body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_NOT_FOUND" } })
    // A delete of a row that the caller cannot see changes nothing, like a delete of a missing row.
    expect(body.results[1]).toEqual({ id: "m3", status: "applied" })
    expect(body.results[2]).toMatchObject({ status: "rejected", error: { code: "SYNC_KEY_EXISTS" } })
    expect(await app.rows()).toEqual([{ id: "b1", ownerId: "bob", title: "Bob's", done: false }])
  })

  it("checks `write`, `schema`, and read-only definitions", async () => {
    const readOnly = await setup({ write: false })
    const reader = await readOnly.start("alice")
    expect((await readOnly.push("alice", { ...as(reader), mutations: [insert("m1", { id: "a1", title: "x" })] })).body.results[0]).toMatchObject({ status: "rejected", error: { code: "SYNC_READ_ONLY" } })

    const checked = await setup({
      write: ({ op, row }) => op !== "delete" && row.title !== "forbidden",
      schema: v.object({ title: v.pipe(v.string(), v.minLength(2, "Write a longer title.")) }),
    })
    const own = await checked.start("alice")
    const { body } = await checked.push("alice", { ...as(own), mutations: [insert("m1", { id: "a1", title: "ok" }), insert("m2", { id: "a2", title: "x" }), insert("m3", { id: "a3", title: "forbidden" }), remove("m4", "a1")] })
    expect(body.results[0]).toEqual({ id: "m1", status: "applied" })
    expect(body.results[1]).toMatchObject({ status: "rejected", error: { code: "SYNC_INVALID", issues: [{ path: "title", message: "Write a longer title." }] } })
    expect(body.results[2]).toMatchObject({ status: "rejected", error: { code: "SYNC_FORBIDDEN" } })
    expect(body.results[3]).toMatchObject({ status: "rejected", error: { code: "SYNC_FORBIDDEN" } })
    expect((await checked.rows()).map(row => row.id)).toEqual(["a1"])
  })

  it("refuses writes of a visitor without `write`, also the writes of an action, and allows them with `write: true`", async () => {
    const closed = await setup({ where: () => ({}), actions: { add: ({ insert }, args: { id: string }) => void insert({ id: args.id, ownerId: "v", title: "From an action" }) } })
    const visitor = await closed.start(null)
    const { body } = await closed.push(null, { ...as(visitor), mutations: [insert("m1", { id: "v1", ownerId: "v", title: "x" }), { id: "m2", op: "action", name: "add", args: { id: "v2" } }] })
    expect(body.results).toEqual([
      { id: "m1", status: "rejected", error: expect.objectContaining({ code: "SYNC_FORBIDDEN", message: expect.stringContaining("set `write: true` to let visitors write") }) },
      { id: "m2", status: "rejected", error: expect.objectContaining({ code: "SYNC_FORBIDDEN" }) },
    ])
    const alice = await closed.start("alice")
    expect((await closed.push("alice", { ...as(alice), mutations: [insert("m3", { id: "a1", ownerId: "alice", title: "x" })] })).body.results).toEqual([{ id: "m3", status: "applied" }])
    expect((await closed.rows()).map(row => row.id)).toEqual(["a1"])

    const open = await setup({ where: () => ({}), write: true })
    const guest = await open.start(null)
    expect((await open.push(null, { ...as(guest), mutations: [insert("m1", { id: "v1", ownerId: "v", title: "x" })] })).body.results).toEqual([{ id: "m1", status: "applied" }])
  })

  it("refuses cross-site, oversized, and malformed pushes", async () => {
    const app = await setup()
    const held = as(await app.start("alice"))
    const one = [insert("m1", { id: "a1", title: "x" })]
    expect(await app.push("alice", { ...held, mutations: one }, { origin: "https://evil.test" })).toMatchObject({ status: 403, body: { code: "SYNC_FORBIDDEN" } })
    expect(await app.push("alice", { ...held, mutations: Array.from({ length: 101 }, (_, index) => insert(`m${index}`, { id: `k${index}`, title: "x" })) })).toMatchObject({ status: 413, body: { code: "SYNC_TOO_MANY_MUTATIONS" } })
    expect(await app.push("alice", { ...held, mutations: [insert("m1", { id: "a1", title: "x".repeat(1024 * 1024) })] })).toMatchObject({ status: 413, body: { code: "SYNC_BAD_REQUEST" } })
    expect(await app.push("alice", { ...held, mutations: [{ id: "m1", op: "upsert" } as never] })).toMatchObject({ status: 400, body: { code: "SYNC_BAD_REQUEST" } })
    expect(await app.rows()).toEqual([])
  })

  it("compacts old deletes, raises the floor, and resets older cursors", async () => {
    const app = await setup()
    const alice = await app.start("alice")
    await app.push("alice", { ...as(alice), mutations: [insert("m1", { id: "a1", title: "Milk" }), insert("m2", { id: "a2", title: "Eggs" })] })
    const old = (await app.pull("alice")).body.cursor
    await app.push("alice", { ...as(alice), mutations: [remove("m3", "a1")] })
    const current = (await app.pull("alice")).body.cursor

    app.clock.now += 31 * day
    await app.push("alice", { ...as(alice), mutations: [update("m4", "a2", { done: true })] })
    const [state] = await app.db.select().from(syncState)
    expect(state).toEqual({ tableName: "todos", floor: current })
    expect(await app.db.select().from(syncChanges).where(eq(syncChanges.op, "delete"))).toEqual([])
    expect((await app.db.select().from(syncMutations)).map(row => row.id)).toEqual(["m4"])

    expect((await app.pull("alice", { cursor: old, ...as(alice) })).body).toMatchObject({ reset: true, rows: [{ id: "a2", done: true }] })
    // A client that saw the removed delete keeps pulling incrementally.
    expect((await app.pull("alice", { cursor: current, ...as(alice) })).body).toMatchObject({ reset: false, rows: [{ id: "a2", done: true }] })
  })
})

it("rejects a constraint violation and continues the push", async () => {
  const app = await setup()
  const alice = await app.start("alice")
  const { body } = await app.push("alice", { ...as(alice), mutations: [insert("bad", { id: "bad" }), insert("good", { id: "good", title: "ok" })] })
  expect(body.results.map(result => result.status)).toEqual(["rejected", "applied"])
  expect((await app.rows()).map(row => row.id)).toEqual(["good"])
})

it("revalidates concurrent patches against the committed row", async () => {
  let release: () => void = () => {}
  const barrier = new Promise<void>(resolve => { release = resolve })
  let waiting = 0
  const app = await setup({ write: async ({ op, row }) => {
    if (op === "update" && ++waiting <= 2) {
      if (waiting === 2) release()
      await barrier
    }
    return !(row.title === "locked" && row.done)
  } })
  const alice = await app.start("alice")
  await app.push("alice", { ...as(alice), mutations: [insert("seed", { id: "a", title: "open" })] })
  const replies = await Promise.all([
    app.push("alice", { ...as(alice), mutations: [update("one", "a", { title: "locked" })] }),
    app.push("alice", { ...as(alice), mutations: [update("two", "a", { done: true })] }),
  ])
  expect(replies.flatMap(reply => reply.body.results.map(result => result.status)).sort()).toEqual(["applied", "rejected"])
  expect((await app.rows()).some(row => row.title === "locked" && row.done)).toBe(false)
})

it("removes a previous owner after a direct scope transfer", async () => {
  const app = await setup()
  const alice = await app.start("alice")
  await app.push("alice", { ...as(alice), mutations: [insert("seed", { id: "a", title: "open" })] })
  const snapshot = await app.start("alice")
  await app.db.update(todos).set({ ownerId: "bob" }).where(eq(todos.id, "a"))
  const { body } = await app.pull("alice", snapshot)
  expect(body.reset).toBe(false)
  expect(body.deleted).toEqual(["a"])
  expect(body.rows).toEqual([])
})
