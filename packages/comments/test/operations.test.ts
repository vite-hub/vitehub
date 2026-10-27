// @vitest-environment node
import { createClient } from "@libsql/client"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { defineComments } from "../src/define.ts"
import { commentsOperations } from "../src/operations.ts"
import { createAuthUsers, createCommentsStore, installComments } from "../src/server.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { CommentsDefinition } from "../src/define.ts"
import type { CommentCreateInput, CommentThread } from "../src/types.ts"

const registry = createOperationRegistry([{ operations: commentsOperations }])
const page = { id: "/pricing", kind: "page" }
const input: CommentCreateInput = { anchor: { kind: "page" }, body: "Review this page.", subject: page }
const member = { id: "ana", name: "Ana", role: "member", email: "ana@example.com" }
const admin = { id: "admin", name: "Admin", role: "admin", email: "admin@example.com" }
const pending: Promise<unknown>[] = []
let client: ReturnType<typeof createClient>

beforeEach(async () => {
  client = createClient({ url: ":memory:" })
  for (const sql of [
    "create table vitehub_comment_threads (id text primary key, scope text not null, n integer not null, subject_kind text not null, subject_id text not null, anchor text not null, status text not null, resolved_by text, resolved_at integer, author_id text not null, author_name text, author_image text, actor text, created_at integer not null, updated_at integer not null)",
    "create unique index vitehub_comment_threads_scope_n on vitehub_comment_threads (scope, n)",
    "create table vitehub_comment_counters (scope text primary key, next integer not null)",
    "create table vitehub_comment_messages (id text primary key, thread_id text not null, body text not null, author_id text not null, author_name text, author_image text, actor text, mentions text not null, attachments text not null, created_at integer not null, edited_at integer)",
  ]) await client.execute(sql)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(pending.splice(0))
  client.close()
  installComments(() => { throw new Error("not installed") })
})

it("scans past more than fifty hidden threads to fill a readable page", async () => {
  setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || thread.messages[0]?.body === "visible" }))
  const visible = await create(member, { ...input, body: "visible" })
  for (let i = 0; i < 51; i++) await create()
  expect(await call("comments.list", { limit: 1 })).toEqual({ ok: true, value: [visible] })
})

it("refuses ownership-based deletion when another author replies after authorization", async () => {
  const store = setup(defineComments({ authorize: ({ action }) => action !== "delete" }))
  const thread = await create()
  const original = store.deleteThread.bind(store)
  let pause!: () => void
  let resume!: () => void
  const paused = new Promise<void>(resolve => { pause = resolve })
  const resumed = new Promise<void>(resolve => { resume = resolve })
  vi.spyOn(store, "deleteThread").mockImplementationOnce(async (...args) => {
    pause()
    await resumed
    return original(...args)
  })
  const deleting = call("comments.delete", { threadId: thread.id })
  await paused
  expect(await call("comments.reply", { body: "Keep my reply", threadId: thread.id }, admin)).toMatchObject({ ok: true })
  resume()
  expect(await deleting).toMatchObject({ ok: false, status: 403 })
  expect((await store.getById(thread.id))?.messages).toHaveLength(2)
})

it("keeps insertion order and deletes only the reply when timestamps collide", async () => {
  const store = setup(defineComments({ authorize: () => true }))
  const message = { attachments: [], author: member, body: "First", id: "z-first", mentions: [], now: 1 }
  const thread = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "thread" })
  const replied = await store.addMessage(thread.id, { ...message, body: "Reply", id: "a-reply" })
  expect(replied.messages.map(entry => entry.id)).toEqual(["z-first", "a-reply"])
  expect(await call("comments.delete", { messageId: "a-reply", threadId: thread.id })).toMatchObject({ ok: true, value: { messages: [{ id: "z-first" }] } })
})

function setup(definition: CommentsDefinition) {
  const store = createCommentsStore(drizzle(client))
  installComments({ definition, store })
  return store
}

function call(name: string, value: unknown, user: OperationContext["user"] = member) {
  return runOperation(registry, name, value, {
    access: { mode: "auth", sections: "all" },
    surface: "console",
    user,
    waitUntil: task => { pending.push(task) },
  })
}

async function create(user = member, value: CommentCreateInput = input): Promise<CommentThread> {
  const result = await call("comments.create", value, user)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value as CommentThread
}

it("passes custom user fields to policies without storing them in comments", async () => {
  const store = setup(defineComments({ authorize: ({ user, action }) => Boolean(user) && (action !== "delete" || user?.role === "admin") }))
  const thread = await create()
  expect(thread.author).toEqual({ id: member.id, name: member.name })
  expect(thread.messages[0]?.author).toEqual(thread.author)
  expect(await call("comments.resolve", { threadId: thread.id }, admin)).toMatchObject({ ok: true })
  expect((await store.getById(thread.id))?.resolvedBy).toEqual({ id: admin.id, name: admin.name })
  expect(await call("comments.delete", { threadId: thread.id }, { ...member, id: "other" })).toMatchObject({ ok: false, status: 403 })
  expect(await call("comments.delete", { threadId: thread.id }, admin)).toEqual({ ok: true, value: null })
})

it("checks read access on the subject before creating a thread", async () => {
  const authorize = vi.fn(({ action }) => action !== "read")
  const store = setup(defineComments({ authorize }))
  expect(await call("comments.create", input)).toMatchObject({ ok: false, status: 403, code: "COMMENTS_R0009" })
  expect(authorize).toHaveBeenCalledExactlyOnceWith({ action: "read", subject: page, user: member })
  expect(await store.list({})).toEqual([])
})

it("checks read access before searching mention suggestions", async () => {
  const definition = defineComments({ authorize: ({ action }) => action !== "read" })
  const store = setup(definition)
  const search = vi.fn(async () => [member])
  installComments({ definition, store, users: { byIds: async () => [], search } })
  expect(await call("comments.users", { query: "an" })).toMatchObject({ ok: false, status: 403, code: "COMMENTS_R0009" })
  expect(search).not.toHaveBeenCalled()
})

it("returns no threads for an anonymous mine query", async () => {
  setup(defineComments({ authorize: () => true }))
  await create()
  expect(await call("comments.list", {}, null)).toMatchObject({ ok: true, value: [expect.anything()] })
  expect(await call("comments.list", { mine: true }, null)).toEqual({ ok: true, value: [] })
})

it.each([false, true])("scans past repeated authors for mention suggestions (hidden: %s)", async (hidden) => {
  setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || !hidden || thread.author.id !== member.id }))
  const prolific = await create()
  const other = { ...member, id: "ben", name: "Anna Other" }
  await create(other)
  await client.batch(Array.from({ length: 201 }, (_, index) => ({
    sql: "insert into vitehub_comment_messages select ?, thread_id, body, author_id, author_name, author_image, actor, mentions, attachments, created_at + 1000 + ?, edited_at from vitehub_comment_messages where id = ?",
    args: [`repeated-${index}`, index, prolific.messages[0]!.id],
  })), "write")
  expect(await call("comments.users", { query: "an" })).toEqual({
    ok: true,
    value: [...(hidden ? [] : [{ id: member.id, name: member.name }]), { id: other.id, name: other.name }],
  })
})

it("uses Auth user fields to authorize mentions and keeps suggestions public", async () => {
  const ben = { id: "ben", name: "Ben", role: "member", email: "ben@example.com" }
  const guest = { id: "guest", name: "Guest", role: "guest", email: "guest@example.com" }
  const onMention = vi.fn()
  const definition = defineComments({ authorize: ({ action, user }) => action !== "read" || user?.role === "member", onMention })
  const store = setup(definition)
  const users = createAuthUsers(() => ({ $context: Promise.resolve({ internalAdapter: { listUsers: async () => [ben, guest] } }) }))
  installComments({ definition, store, users })
  await create(member, { ...input, body: "Hello @Ben and @Guest.", mentions: [ben.id, guest.id] })
  await Promise.all(pending)
  expect(onMention).toHaveBeenCalledOnce()
  expect(onMention.mock.calls[0]?.[0].mentioned.map((person: { id: string }) => person.id)).toEqual([ben.id])
  expect(onMention.mock.calls[0]?.[0].mentioned).toEqual([{ id: ben.id, name: ben.name }])
  expect(await call("comments.users", { query: "be" })).toEqual({ ok: true, value: [{ id: ben.id, name: ben.name }, { id: guest.id, name: guest.name }] })
})
