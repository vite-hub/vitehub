import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createCommentsStore } from "../src/store.ts"
import { ada, anchor, commentsMigration, grace } from "./harness.ts"

import type { Client } from "@libsql/client"
import type { CommentsDatabase } from "../src/store.ts"

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

it("reads threads and their comments in one round trip", async () => {
  const { calls, store } = await countedStore()
  const first = await store.create({ scope: "pages", page: "/", anchor, body: "First", author: ada, mentions: [] })
  const second = await store.create({ scope: "pages", page: "/", anchor, body: "Second", author: ada, mentions: [] })
  await store.reply(first.id, { body: "Reply", author: grace, mentions: [] })

  calls.count = 0
  const listed = await store.list({ scope: "pages", page: "/", limit: 10 })
  expect(calls.count).toBe(1)
  expect(listed.map(thread => thread.comments.map(comment => comment.body))).toEqual([["First", "Reply"], ["Second"]])

  calls.count = 0
  expect((await store.get(second.id))?.comments.map(comment => comment.body)).toEqual(["Second"])
  expect(calls.count).toBe(1)

  calls.count = 0
  expect((await store.getByNumber("pages", first.number))?.comments).toHaveLength(2)
  expect(calls.count).toBe(1)

  calls.count = 0
  expect(await store.get("missing")).toBeUndefined()
  expect(calls.count).toBe(1)
})

it("loads comments only for the threads inside the limit", async () => {
  const { store } = await countedStore()
  const older = await store.create({ scope: "pages", page: "/", anchor, body: "Older", author: ada, mentions: [] })
  await store.create({ scope: "pages", page: "/", anchor, body: "Newer", author: ada, mentions: [] })
  await store.reply(older.id, { body: "Bump", author: grace, mentions: [] })

  const listed = await store.list({ scope: "pages", limit: 1 })
  expect(listed.map(thread => thread.comments.map(comment => comment.body))).toEqual([["Older", "Bump"]])
})
