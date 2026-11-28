import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCommentsStore } from "../src/operations-core/store.ts"
import { ada, anchor, commentsMigration, createD1LimitedDatabase, grace } from "./harness.ts"

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
  const store = createCommentsStore(drizzle({ client: counted }) as unknown as CommentsDatabase)
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
    const db = new Proxy(drizzle({ client }), { get: (target, key, receiver) => key === "batch" ? undefined : Reflect.get(target, key, receiver) })
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

it("inserts one thread when two creates with the same requestId race", async () => {
  const { store } = await countedStore()
  const first = { ...thread("First"), requestId: "draft-1" }
  const [a, b] = await Promise.all([store.createThread(first), store.createThread({ ...thread("First"), requestId: "draft-1" })])
  expect(a).toEqual(b)
  expect(await store.list({ limit: 10 })).toHaveLength(1)
  expect((await store.createThread({ ...thread("Other scope"), requestId: "draft-1", scope: "doc:guide" })).id).not.toBe(a.id)
})

it("keeps the agent that resolved a thread until it opens again, and reads resolvers stored without one", async () => {
  const { store } = await countedStore()
  const opened = await store.createThread({ ...thread("Grace asks"), author: grace })
  const claude = { id: "claude", name: "Claude" }

  expect(await store.setStatus(opened.id, "resolved", ada, Date.now(), claude)).toMatchObject({ resolvedBy: ada, resolvedActor: claude })
  const reopened = await store.setStatus(opened.id, "open", ada, Date.now())
  expect(reopened.resolvedBy).toBeUndefined()
  expect(reopened.resolvedActor).toBeUndefined()
  const byHand = await store.setStatus(opened.id, "resolved", grace, Date.now())
  expect(byHand.resolvedBy).toEqual(grace)
  expect(byHand.resolvedActor).toBeUndefined()

  await store.setStatus(opened.id, "resolved", ada, Date.now(), claude)
  expect(await store.deleteUser("ada")).toEqual([opened.id])
  expect(await store.getById(opened.id)).toMatchObject({ status: "resolved", messages: [{ body: "Grace asks" }] })
  expect((await store.getById(opened.id))?.resolvedActor).toBeUndefined()
})

it("deletes the messages of one person and keeps the replies of other people", async () => {
  const { store } = await countedStore()
  const alone = await store.createThread(thread("Only Ada wrote here"))
  const replied = await store.createThread(thread("Ada asks"))
  await store.addMessage(replied.id, message("Grace answers", grace))
  const answered = await store.createThread({ ...thread("Grace asks"), author: grace })
  await store.addMessage(answered.id, message("Ada answers"))
  const unrelated = await store.createThread({ ...thread("Grace only"), author: grace })
  await store.setStatus(unrelated.id, "resolved", ada, Date.now())

  expect((await store.deleteUser("ada")).sort()).toEqual([alone.id, replied.id, answered.id, unrelated.id].sort())

  expect(await store.getById(alone.id)).toBeNull()
  const kept = await store.getById(replied.id)
  expect(kept?.author).toEqual({ id: "ada" })
  expect(kept?.messages.map(entry => entry.body)).toEqual(["Grace answers"])
  expect((await store.getById(answered.id))?.messages.map(entry => entry.body)).toEqual(["Grace asks"])
  const resolved = await store.getById(unrelated.id)
  expect(resolved).toMatchObject({ status: "resolved", messages: [{ body: "Grace only" }] })
  expect(resolved?.resolvedBy).toBeUndefined()
  expect(await store.deleteUser("ada")).toEqual([])
})

describe("on a Database with the D1 limit of 50 bytes per LIKE pattern", () => {
  const end = "4642b2c6-c837-4bc3-a542-852415e0167e/image.png"

  it("finds the threads of a long attachment key, and not those of a key with the same end", async () => {
    const store = createCommentsStore(createD1LimitedDatabase())
    const key = `comments/page/${end}`
    const wanted = await store.createThread({ ...thread("Look"), attachments: [key] })
    await store.createThread({ ...thread("Other"), attachments: [`drops/${end}`] })
    expect((await store.getByAttachment(key)).threads.map(entry => entry.id)).toEqual([wanted.id])
  })

  it("finds a long attachment on the first page despite other uploads with the same filename", async () => {
    const store = createCommentsStore(createD1LimitedDatabase())
    const filename = "monthly-design-review-desktop-dark-mode-screenshot.png"
    const key = `comments/page/wanted/${filename}`
    for (let index = 0; index < 200; index++) {
      await store.createThread({ ...thread("Other"), id: `other-${index}`, attachments: [`comments/page/${index}/${filename}`] })
    }
    const wanted = await store.createThread({ ...thread("Look"), id: "wanted", attachments: [key] })

    const page = await store.getByAttachment(key)
    expect(page.threads.map(entry => entry.id)).toEqual([wanted.id])
    expect(page.cursor).toBeUndefined()
  })

  it("deletes a person with a long id who resolved a thread", async () => {
    const store = createCommentsStore(createD1LimitedDatabase())
    const person = { id: `github:${end}`, name: "Ada" }
    const opened = await store.createThread({ ...thread("Grace asks"), author: grace })
    await store.setStatus(opened.id, "resolved", person, Date.now())
    expect(await store.deleteUser(person.id)).toEqual([opened.id])
    expect((await store.getById(opened.id))?.resolvedBy).toBeUndefined()
  })
})

it("checks for surviving replies and the current resolver after locking the thread", async () => {
  const client = createClient({ url: ":memory:" })
  try {
    await client.executeMultiple(commentsMigration)
    const store = createCommentsStore(drizzle({ client }))
    const opened = await store.createThread(thread("Ada asks"))
    await store.setStatus(opened.id, "resolved", ada, Date.now())
    await client.execute(`CREATE TRIGGER reply_before_thread_lock BEFORE UPDATE OF id ON vitehub_comment_threads BEGIN
      INSERT INTO vitehub_comment_messages (id, thread_id, body, author_id, mentions, attachments, created_at)
      VALUES ('racing-reply', OLD.id, 'Grace answers', 'grace', '[]', '[]', 1);
      UPDATE vitehub_comment_threads SET resolved_by = '{"id":"grace"}' WHERE id = OLD.id;
    END`)

    await expect(store.deleteUser("ada")).resolves.toEqual([opened.id])
    expect(await store.getById(opened.id)).toMatchObject({ resolvedBy: { id: "grace" }, messages: [{ body: "Grace answers" }] })
  }
  finally {
    client.close()
  }
})

describe.each(["batch", "statements"] as const)("people search with %s reads", (driver) => {
  async function peopleStore() {
    const client = createClient({ url: ":memory:" })
    await client.executeMultiple(commentsMigration)
    const calls = { count: 0 }
    const limits = { threadsPerMessageRead: Number.POSITIVE_INFINITY }
    const ids: string[] = []
    const statementsOf = (key: string | symbol, args: unknown[]) => (key === "batch" ? args[0] : [args[0]]) as { sql: string, args?: unknown[] }[]
    const counted = new Proxy(client, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          if (key === "execute" || key === "batch") {
            calls.count++
            const tooLarge = statementsOf(key, args).some(statement => /from "vitehub_comment_messages" where/.test(statement.sql)
              && (statement.args ?? []).filter(arg => typeof arg === "string" && ids.includes(arg)).length > limits.threadsPerMessageRead)
            if (tooLarge) return Promise.reject(new Error("D1_ERROR: the result is too large"))
          }
          return Reflect.apply(value, target, args)
        }
      },
    }) satisfies Client
    const database = drizzle({ client: counted })
    const db = driver === "batch" ? database : new Proxy(database, { get: (target, key, receiver) => key === "batch" ? undefined : Reflect.get(target, key, receiver) })
    // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
    const store = createCommentsStore(db as unknown as CommentsDatabase)
    const lin = { id: "lin", name: "Lin" }
    for (let index = 0; index < 60; index++) {
      const created = await store.createThread({ ...thread(`Thread ${index}`), author: { ...ada, name: `Ada ${index}` } })
      ids.push(created.id)
      if (index === 2) await store.addMessage(created.id, message("Reply", grace))
      if (index % 2) await store.addMessage(created.id, message("Reply", lin))
    }
    return { calls, client, ids, limits, store }
  }

  async function deleteThread(client: Client, id: string) {
    await client.execute({ sql: "DELETE FROM vitehub_comment_messages WHERE thread_id = ?", args: [id] })
    await client.execute({ sql: "DELETE FROM vitehub_comment_threads WHERE id = ?", args: [id] })
  }

  it("finds the newest readable name of each person, checks a denied thread once, and reads candidate threads together", async () => {
    const { calls, client, ids, store } = await peopleStore()
    try {
      const checked: string[] = []
      const evenThreads = async (found: { id: string }) => {
        checked.push(found.id)
        return ids.indexOf(found.id) % 2 === 0
      }
      const checkedAgain = () => checked.filter((id, index) => checked.indexOf(id) !== index)
      calls.count = 0
      expect(await store.knownUsers("", 16, evenThreads)).toEqual([{ id: "ada", name: "Ada 58" }, { id: "grace", name: "Grace" }])
      expect(checkedAgain().every(id => ids.indexOf(id) % 2 === 0 && checked.filter(other => other === id).length === 2)).toBe(true)
      expect(calls.count).toBeLessThanOrEqual(driver === "batch" ? 9 : 16)

      checked.length = 0
      calls.count = 0
      expect(await store.knownUsersByIds(["lin", "grace", "ada"], evenThreads)).toEqual([{ id: "ada", name: "Ada 58" }, { id: "grace", name: "Grace" }])
      expect(checkedAgain().every(id => ids.indexOf(id) % 2 === 0 && checked.filter(other => other === id).length === 2)).toBe(true)
      expect(calls.count).toBeLessThanOrEqual(driver === "batch" ? 8 : 15)
    }
    finally {
      client.close()
    }
  })

  it("reads one thread when the newest candidate is readable", async () => {
    const { calls, client, store } = await peopleStore()
    try {
      calls.count = 0
      expect(await store.knownUsers("ada", 1, async () => true)).toEqual([{ id: "ada", name: "Ada 59" }])
      expect(calls.count).toBe(driver === "batch" ? 2 : 3)
    }
    finally {
      client.close()
    }
  })

  it("skips a candidate thread that is deleted during the search", async () => {
    const { client, ids, store } = await peopleStore()
    try {
      const deleted = ids[58]!
      const readable = async (found: { id: string }) => {
        if (found.id === ids[59]) {
          await deleteThread(client, deleted)
          return false
        }
        return true
      }
      expect(await store.knownUsers("ada", 1, readable)).toEqual([{ id: "ada", name: "Ada 57" }])
    }
    finally {
      client.close()
    }
  })

  it.each(["knownUsers", "knownUsersByIds"] as const)("%s skips a thread that was read with an earlier one and deleted before its check ends", async (lookup) => {
    const { client, ids, store } = await peopleStore()
    try {
      const readable = async (found: { id: string }) => {
        if (found.id === ids[59]) return false
        if (found.id === ids[58]) {
          await deleteThread(client, ids[57]!)
          return false
        }
        return true
      }
      const found = lookup === "knownUsers" ? await store.knownUsers("ada", 1, readable) : await store.knownUsersByIds(["ada"], readable)
      expect(found).toEqual([{ id: "ada", name: "Ada 56" }])
    }
    finally {
      client.close()
    }
  })

  it.each(["knownUsers", "knownUsersByIds"] as const)("%s reads one thread at a time when a read of several threads is too large", async (lookup) => {
    const { client, ids, limits, store } = await peopleStore()
    try {
      limits.threadsPerMessageRead = 1
      const checked: string[] = []
      const readable = async (found: { id: string }) => {
        checked.push(found.id)
        return found.id !== ids[59] && found.id !== ids[58]
      }
      const found = lookup === "knownUsers" ? await store.knownUsers("ada", 1, readable) : await store.knownUsersByIds(["ada"], readable)
      expect(found).toEqual([{ id: "ada", name: "Ada 57" }])
      expect(checked.slice(0, 3)).toEqual([ids[59], ids[58], ids[57]])
    }
    finally {
      client.close()
    }
  })
})
