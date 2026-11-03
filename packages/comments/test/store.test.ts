import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createCommentsStore } from "../src/operations-core/store.ts"
import { ada, anchor, commentsMigration, grace } from "./harness.ts"

import type { Client } from "@libsql/client"
import type { CommentsDatabase, NewMessage } from "../src/operations-core/store.ts"

// Each write gets its own millisecond, so the newest-activity order does not fall back to random IDs.
beforeEach(() => {
  let now = Date.UTC(2026, 0, 1)
  vi.spyOn(Date, "now").mockImplementation(() => now += 1_000)
})
afterEach(() => vi.restoreAllMocks())

/** A store whose database counts its calls to libSQL. Each call is one round trip, such as one D1 request. */
async function countedStore() {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(commentsMigration)
  const calls = { count: 0 }
  const counted = new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        if (key === "execute" || key === "batch") calls.count++
        return Reflect.apply(value, target, args)
      }
    },
  }) satisfies Client
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  const store = createCommentsStore(drizzle(counted) as unknown as CommentsDatabase)
  return { calls, store }
}

let next = 0
const message = (body: string, author = ada): NewMessage => ({ attachments: [], author, body, id: `message-${++next}`, mentions: [], now: Date.now() })
const thread = (body: string) => ({ ...message(body), anchor, scope: "site", subject: { kind: "page", id: "/" }, threadId: `thread-${++next}` })

it("reads threads and their messages in one round trip", async () => {
  const { calls, store } = await countedStore()
  const first = await store.createThread(thread("First"))
  const second = await store.createThread(thread("Second"))
  await store.addMessage(first.id, message("Reply", grace))

  calls.count = 0
  const listed = await store.list({ subject: { kind: "page", id: "/" }, limit: 10 })
  expect(calls.count).toBe(1)
  expect(listed.map(item => item.messages.map(entry => entry.body))).toEqual([["First", "Reply"], ["Second"]])

  calls.count = 0
  expect((await store.getById(second.id))?.messages.map(entry => entry.body)).toEqual(["Second"])
  expect(calls.count).toBe(1)

  calls.count = 0
  expect((await store.getByNumber("site", first.n))?.messages).toHaveLength(2)
  expect(calls.count).toBe(1)

  calls.count = 0
  expect(await store.getById("missing")).toBeNull()
  expect(calls.count).toBe(1)
})

it("loads messages only for the threads inside the limit", async () => {
  const { store } = await countedStore()
  const older = await store.createThread(thread("Older"))
  await store.createThread(thread("Newer"))
  await store.addMessage(older.id, message("Bump", grace))

  const listed = await store.list({ scope: "site", limit: 1 })
  expect(listed.map(item => item.messages.map(entry => entry.body))).toEqual([["Older", "Bump"]])
})

it("removes threads before messages in transactions so an interleaved reply cannot survive", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    await client.executeMultiple(commentsMigration)
    const db = new Proxy(drizzle(client), { get: (target, key, receiver) => key === "batch" ? undefined : Reflect.get(target, key, receiver) })
    const store = createCommentsStore(db)
    const first = await store.createThread(thread("Delete this"))
    const other = await store.createThread({ ...thread("Keep this"), scope: "other" })
    // Inject a reply at the message-deletion boundary, using the same thread-existence guard as addMessage.
    // This reproduces the Postgres interleaving without relying on scheduler timing.
    await client.execute(`CREATE TRIGGER interleaved_reply AFTER DELETE ON vitehub_comment_messages BEGIN
      INSERT INTO vitehub_comment_messages (id, thread_id, body, author_id, mentions, attachments, created_at)
      SELECT 'racing-reply', OLD.thread_id, 'Concurrent reply', 'grace', '[]', '[]', 1
      FROM vitehub_comment_threads WHERE id = OLD.thread_id;
    END`)
    expect(await store.deleteScope("site")).toEqual([first.id])
    expect((await client.execute({ sql: "SELECT id FROM vitehub_comment_messages WHERE thread_id = ?", args: [first.id] })).rows).toEqual([])
    expect((await store.getById(other.id))?.messages).toHaveLength(1)
    expect((await store.createThread(thread("Next"))).n).toBe(2)
  }
  finally {
    client.close()
  }
})
