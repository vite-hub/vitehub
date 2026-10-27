import { describe, expect, it, vi } from "vitest"

import { createCommentsClient, type CommentThread, type CommentUser } from "../src/client.ts"
import { createMemoryTransport } from "../src/testing.ts"

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" }
const ben: CommentUser = { id: "ben", name: "Ben Soto" }
const subject = { kind: "page", id: "/pricing" }
const anchor = { kind: "element", selector: "#cta", x: 500, y: 500 } as const

function setup() {
  const store = createMemoryTransport({ user: ana, users: [ana, ben] })
  const client = createCommentsClient({ transport: store, user: ana, query: { page: "/pricing" } })
  return { client, store }
}

describe("createCommentsClient", () => {
  it("numbers threads, keeps them in the cache, and tells listeners", async () => {
    const { client } = setup()
    const changes = vi.fn()
    client.onChange(changes)

    const first = await client.create({ subject, anchor, body: "  Too small  " })
    const second = await client.create({ subject, anchor, body: "Wrong color" })

    expect([first.n, second.n]).toEqual([1, 2])
    expect(first.messages[0]).toMatchObject({ body: "Too small", author: ana })
    expect(client.threads.map(thread => thread.n)).toEqual([1, 2])
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it("replies, edits, resolves, reopens, and deletes", async () => {
    const { client } = setup()
    const thread = await client.create({ subject, anchor, body: "First" })

    const replied = await client.reply({ threadId: thread.id, body: "Second", mentions: ["ben"] })
    expect(replied.messages.map(message => message.body)).toEqual(["First", "Second"])

    const edited = await client.edit({ threadId: thread.id, messageId: replied.messages[1]!.id, body: "Second, edited" })
    expect(edited.messages[1]).toMatchObject({ body: "Second, edited", editedAt: expect.any(Number) })

    expect(await client.resolve({ threadId: thread.id })).toMatchObject({ status: "resolved", resolvedBy: ana })
    expect(await client.reopen({ threadId: thread.id })).toMatchObject({ status: "open" })
    expect((await client.reopen({ threadId: thread.id })).resolvedBy).toBeUndefined()

    const afterReply = await client.delete({ threadId: thread.id, messageId: replied.messages[1]!.id })
    expect(afterReply?.messages).toHaveLength(1)
    expect(await client.delete({ threadId: thread.id })).toBeNull()
    expect(client.threads).toEqual([])
  })

  it("only lets authors edit and delete their own messages", async () => {
    const { client, store } = setup()
    const thread = await client.create({ subject, anchor, body: "Mine" })
    const other = createCommentsClient({ transport: store.as(ben), user: ben })

    await expect(other.edit({ threadId: thread.id, messageId: thread.messages[0]!.id, body: "Hacked" })).rejects.toMatchObject({
      code: "COMMENTS_R0004",
    })
    await expect(other.delete({ threadId: thread.id })).rejects.toMatchObject({ code: "COMMENTS_R0004" })
    expect(await other.resolve({ threadId: thread.id })).toMatchObject({ status: "resolved", resolvedBy: ben })
  })

  it.each([false, true])("preserves other authors' replies when deleting a thread (first message: %s)", async (firstMessage) => {
    const { client, store } = setup()
    const thread = await client.create({ subject, anchor, body: "Mine" })
    const replied = await store.as(ben).reply({ threadId: thread.id, body: "Ben's reply" })
    await expect(client.delete({ threadId: thread.id, ...(firstMessage ? { messageId: thread.messages[0]!.id } : {}) })).rejects.toMatchObject({ code: "COMMENTS_R0004" })
    expect((await store.get({ id: thread.id }))?.messages).toHaveLength(2)
    await store.as(ben).delete({ threadId: thread.id, messageId: replied.messages[1]!.id })
    expect(await client.delete({ threadId: thread.id })).toBeNull()
  })

  it("rejects an empty comment and an unknown thread with a coded error", async () => {
    const { client } = setup()
    await expect(client.create({ subject, anchor, body: "   " })).rejects.toMatchObject({ code: "COMMENTS_R0005" })
    await expect(client.reply({ threadId: "nope", body: "Hi" })).rejects.toMatchObject({ code: "COMMENTS_R0002" })
  })

  it("lists by page, status, mine, and mentions, and gets by number", async () => {
    const { client, store } = setup()
    const a = await client.create({ subject, anchor, body: "A" })
    await client.create({ subject: { kind: "page", id: "/about" }, anchor, body: "B" })
    const benClient = createCommentsClient({ transport: store.as(ben), user: ben })
    await benClient.create({ subject, anchor, body: "C @ana", mentions: ["ana"] })
    await client.resolve({ threadId: a.id })

    const list = (query: Parameters<typeof store.list>[0]) => store.list(query).then(threads => threads.map(thread => thread.n))
    expect(await list({ page: "/pricing" })).toEqual([1, 3])
    expect(await list({ subject })).toEqual([1, 3])
    expect(await list({ status: "resolved" })).toEqual([1])
    expect(await list({ mine: true })).toEqual([1, 2])
    expect(await list({ mentions: true })).toEqual([3])
    expect(await client.get({ n: 3, scope: "site" })).toMatchObject({ id: expect.any(String), n: 3 })
    expect(await client.get({ n: 9, scope: "site" })).toBeNull()
  })

  it("finds users for mentions", async () => {
    const { client } = setup()
    expect(await client.users({ query: "be" })).toEqual([ben])
  })

  it("refreshes with its query and ignores a stale answer", async () => {
    const { client, store } = setup()
    await client.create({ subject, anchor, body: "Here" })
    await store.create({ subject: { kind: "page", id: "/about" }, anchor, body: "There" })

    expect((await client.refresh()).map(thread => thread.subject.id)).toEqual(["/pricing"])
    expect(client.status).toBe("ready")

    client.query = {}
    expect((await client.refresh()).map(thread => thread.subject.id)).toEqual(["/pricing", "/about"])
  })

  it("reports a failed refresh in status and error", async () => {
    const failing = createMemoryTransport({ user: ana })
    const failure = new Error("offline")
    failing.list = () => Promise.reject(failure)
    const client = createCommentsClient({ transport: failing })

    await expect(client.refresh()).rejects.toBe(failure)
    expect(client.status).toBe("error")
    expect(client.error).toBe(failure)
  })

  it("starts with a refresh and applies pushed events until stopped", async () => {
    const { client, store } = setup()
    const stop = client.start()
    await vi.waitFor(() => expect(client.status).toBe("ready"))

    const theirs = await createCommentsClient({ transport: store.as(ben), user: ben }).create({ subject, anchor, body: "Live" })
    expect(client.threads.map(thread => thread.id)).toEqual([theirs.id])
    await store.as(ben).delete({ threadId: theirs.id })
    expect(client.threads).toEqual([])

    stop()
    await store.as(ben).create({ subject, anchor, body: "After stop" })
    expect(client.threads).toEqual([])
  })

  it("refreshes on window focus when the transport cannot push", async () => {
    const store = createMemoryTransport({ user: ana })
    const { subscribe: _subscribe, ...pull } = store
    const client = createCommentsClient({ transport: pull, query: {} })
    const stop = client.start()
    await vi.waitFor(() => expect(client.status).toBe("ready"))

    await store.create({ subject, anchor, body: "Elsewhere" })
    expect(client.threads).toHaveLength(0)
    window.dispatchEvent(new Event("focus"))
    await vi.waitFor(() => expect(client.threads).toHaveLength(1))
    stop()
  })

  describe("races", () => {
    it.each(["reply", "edit"] as const)("keeps the newest same-millisecond %s when responses arrive in reverse order", async (action) => {
      const store = createMemoryTransport({ user: ana, now: () => 1 })
      const thread = await store.create({ subject, anchor, body: "First" })
      const pending: Array<() => void> = []
      const delay = (snapshot: CommentThread) => new Promise<CommentThread>(resolve => pending.push(() => resolve(snapshot)))
      const transport = {
        ...store,
        reply: (input: Parameters<typeof store.reply>[0]) => store.reply(input).then(delay),
        edit: (input: Parameters<typeof store.edit>[0]) => store.edit(input).then(delay),
      }
      const client = createCommentsClient({ transport })
      const mutate = (body: string) => action === "reply"
        ? client.reply({ threadId: thread.id, body })
        : client.edit({ threadId: thread.id, messageId: thread.messages[0]!.id, body })
      const older = mutate("Second")
      const newer = mutate("Third")
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      pending[1]!()
      await newer
      pending[0]!()
      await older
      expect(client.threads[0]!.messages.map(message => message.body)).toEqual(action === "reply" ? ["First", "Second", "Third"] : ["Third"])
    })

    // A transport whose list answers when the test says so, with what the server knew when it was asked.
    function slowList() {
      const store = createMemoryTransport({ user: ana, now: () => 1 })
      const pending: Array<{ answer: () => void }> = []
      const transport = {
        ...store,
        list: (query: Parameters<typeof store.list>[0]) =>
          store.list(query).then(
            threads => new Promise<CommentThread[]>(resolve => pending.push({ answer: () => resolve(threads) })),
          ),
      }
      return { pending, store, transport }
    }

    it("keeps a thread that was created while the list was on its way", async () => {
      const { pending, transport } = slowList()
      const client = createCommentsClient({ transport })
      const loading = client.refresh()
      await vi.waitFor(() => expect(pending).toHaveLength(1))

      const created = await client.create({ subject, anchor, body: "Made during the list" })
      pending[0]!.answer()
      await loading

      expect(client.threads.map(thread => thread.id)).toEqual([created.id])
    })

    it("does not bring back a thread that was deleted while the list was on its way", async () => {
      const { pending, store, transport } = slowList()
      const old = await store.create({ subject, anchor, body: "Old" })
      const client = createCommentsClient({ transport })
      const loading = client.refresh()
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      pending[0]!.answer()
      await loading
      expect(client.threads).toHaveLength(1)

      const again = client.refresh()
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      await client.delete({ threadId: old.id })
      pending[1]!.answer()
      await again
      expect(client.threads).toEqual([])
    })

    it("keeps the locally changed thread when the list has an equal timestamp", async () => {
      const { pending, store, transport } = slowList()
      const thread = await store.create({ subject, anchor, body: "First" })
      const reply = transport.reply
      transport.reply = async input => ({ ...await reply(input), updatedAt: thread.updatedAt })
      const client = createCommentsClient({ transport })
      const loading = client.refresh()
      await vi.waitFor(() => expect(pending).toHaveLength(1))

      // The list was cut before the reply, and the reply comes back after it.
      await client.reply({ threadId: thread.id, body: "Second" })
      pending[0]!.answer()
      await loading
      expect(client.threads[0]!.updatedAt).toBe(thread.updatedAt)
      expect(client.threads[0]!.messages.map(message => message.body)).toEqual(["First", "Second"])
    })

    it("applies an event that arrives while start() is still listing, and ignores an older one", async () => {
      const { pending, store, transport } = slowList()
      const client = createCommentsClient({ transport })
      const stop = client.start()
      await vi.waitFor(() => expect(pending).toHaveLength(1))

      const theirs = await store.as(ben).create({ subject, anchor, body: "While listing" })
      expect(client.threads.map(thread => thread.id)).toEqual([theirs.id])

      pending[0]!.answer()
      await vi.waitFor(() => expect(client.status).toBe("ready"))
      expect(client.threads.map(thread => thread.id)).toEqual([theirs.id])

      const newer = await store.as(ben).reply({ threadId: theirs.id, body: "Newer" })
      expect(client.threads[0]!.messages).toHaveLength(2)
      // A copy of the thread from before the reply came late. It must not undo the reply.
      const stale: CommentThread = { ...newer, messages: newer.messages.slice(0, 1), updatedAt: newer.updatedAt - 1000 }
      const listeners: Array<(event: { type: "thread", thread: CommentThread }) => void> = []
      const pushing = createCommentsClient({
        transport: { ...store, subscribe: listener => { listeners.push(listener); return () => undefined } },
      })
      pushing.start()
      await vi.waitFor(() => expect(pushing.status).toBe("ready"))
      listeners[0]!({ type: "thread", thread: newer })
      listeners[0]!({ type: "thread", thread: stale })
      expect(pushing.threads[0]!.messages).toHaveLength(2)
      stop()
    })

    it("lists again once after the transport reconnects", async () => {
      const store = createMemoryTransport({ user: ana })
      const list = vi.spyOn(store, "list")
      const client = createCommentsClient({ transport: store })
      const stop = client.start()
      await vi.waitFor(() => expect(client.status).toBe("ready"))
      expect(list).toHaveBeenCalledTimes(1)

      await store.create({ subject, anchor, body: "Missed while offline" })
      store.reconnect()
      await vi.waitFor(() => expect(client.threads).toHaveLength(1))
      expect(list).toHaveBeenCalledTimes(2)
      stop()
    })
  })
})

it("loads every page before marking the cache ready", async () => {
  const store = createMemoryTransport({ user: ana })
  const sample = await store.create({ subject, anchor, body: "First" })
  const all = Array.from({ length: 201 }, (_, i) => ({ ...sample, id: `thread-${i}`, n: i + 1, updatedAt: 201 - i }))
  const list = vi.fn(async (query: Parameters<typeof store.list>[0]) => {
    const start = query.before ? all.findIndex(thread => thread.id === query.before?.id) + 1 : 0
    return all.slice(start, start + (query.limit ?? 200))
  })
  const client = createCommentsClient({ transport: { ...store, list }, query: { page: subject.id } })
  await client.refresh()
  expect(client.status).toBe("ready")
  expect(client.threads).toHaveLength(201)
  expect(list).toHaveBeenCalledTimes(2)
  expect(list.mock.calls[1]?.[0]).toMatchObject({ before: { id: "thread-199", updatedAt: 2 }, page: subject.id })
})
