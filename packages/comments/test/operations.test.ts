// @vitest-environment node
import { createClient } from "@libsql/client"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { drizzle } from "drizzle-orm/libsql"
import { H3Event } from "h3"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

// Exercise the built Node transport without pulling its Vite helpers into Comments' DOM typecheck.
import { createStandaloneOperationHandler } from "../../internal/dist/operations-dev.js"
import { defineCommentSubject, defineComments } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { commentsOperations } from "../src/operations-core/operations.ts"
import { createAuthUsers, installCommentsRuntime } from "../src/operations-core/server.ts"
import { createCommentsStore } from "../src/operations-core/store.ts"
import { createRpcTransport } from "../src/rpc.ts"
import { createMemoryTransport } from "../src/testing.ts"
import { commentsTables } from "../src/tables.ts"
import { operationRpcBody, operationRpcRequest, operationRpcResponse, operationRpcResult } from "../../internal/test-utils/operation-rpc.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { Comments } from "../src/index.ts"
import type { CommentsDatabase } from "../src/operations-core/store.ts"
import type { CommentsIdentifyContext, CommentsPeople, CommentsUser } from "../src/types.ts"
import type { CommentCreateInput, CommentThread } from "../src/operations-core/types.ts"

const registry = createOperationRegistry([{ operations: commentsOperations }])
const page = { id: "/pricing", kind: "page" }
const input: CommentCreateInput = { anchor: { kind: "page" }, body: "Review this page.", subject: page }
const member = { id: "ana", name: "Ana", role: "member", email: "ana@example.com" }
const admin = { id: "admin", name: "Admin", role: "admin", email: "admin@example.com" }
const pending: Promise<unknown>[] = []
let client: ReturnType<typeof createClient>

beforeEach(async () => {
  client = createClient({ url: ":memory:" })
  for (const sql of commentsTables) await client.execute(sql)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(pending.splice(0))
  client.close()
  installCommentsRuntime(() => { throw new Error("not installed") })
})

it("scans past more than fifty hidden threads to fill a readable page", async () => {
  setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || thread.messages[0]?.body === "visible" }))
  const visible = await create(member, { ...input, body: "visible" })
  for (let i = 0; i < 51; i++) await create()
  expect(await call("comments.list", { limit: 1 })).toEqual({ ok: true, value: [visible] })
})

it.each(["rpc", "memory"])("filters subject kinds before limiting through the %s transport", async (kind) => {
  const store = setup(defineComments({ authorize: () => true }))
  const message = { attachments: [], author: member, body: "Page", id: "page-message", mentions: [], now: 1 }
  const visible = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "page" })
  const content = await store.createThread({ ...message, id: "content-message", now: 2, anchor: { kind: "page" }, scope: "site", subject: { kind: "content", id: "about" }, threadId: "content" })
  const transport = kind === "memory"
    ? createMemoryTransport({ user: member, threads: [visible, content] })
    : createRpcTransport({ fetch: async (_url, init) => {
        const { operation, input } = operationRpcRequest(init?.body)
        return operationRpcResponse(init?.body, await call(operation, input))
      } })
  expect(await transport.list({ subjectKind: "page", limit: 1 })).toEqual([visible])
  expect(await transport.list({ subjectKind: "content" })).toEqual([content])
  expect(await transport.list({ subjectKind: "missing" })).toEqual([])
  expect(await transport.list({ subjectKind: "page", subject: content.subject })).toEqual([])
})

it("accepts attachment keys through the RPC transport for new comments and replies", async () => {
  setup(defineComments({ authorize: () => true }))
  const transport = createRpcTransport({ fetch: async (_url, init) => {
    const { operation, input } = operationRpcRequest(init?.body)
    return operationRpcResponse(init?.body, await call(operation, input))
  } })
  const thread = await transport.create({ ...input, attachments: ["uploads/first.png"] })
  expect(thread.messages[0]!.attachments).toEqual(["uploads/first.png"])
  const replied = await transport.reply({ threadId: thread.id, body: "", attachments: ["uploads/reply.png"] })
  expect(replied.messages[1]!.attachments).toEqual(["uploads/reply.png"])
  expect(transport.supportsAttachments).not.toBe(false)
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

it("gives each same-millisecond mutation a strictly newer timestamp", async () => {
  const store = setup(defineComments({ authorize: () => true }))
  const message = { attachments: [], author: member, body: "First", id: "first", mentions: [], now: 1 }
  const created = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "thread" })
  const replied = await store.addMessage(created.id, { ...message, body: "Reply", id: "reply" })
  const edited = await store.editMessage(created.id, "reply", { body: "Edited", mentions: [], now: 1 })
  const resolved = await store.setStatus(created.id, "resolved", member, 1)
  const reopened = await store.setStatus(created.id, "open", member, 1)
  const deleted = await store.deleteMessage(created.id, "reply", 1)
  expect([created, replied, edited, resolved, reopened, deleted].map(thread => thread.updatedAt)).toEqual([1, 2, 3, 4, 5, 6])
})

it.each([1, 10])("orders a same-millisecond reply after resolution (created at %i)", async (createdAt) => {
  const store = setup(defineComments({ authorize: () => true }))
  const message = { attachments: [], author: member, body: "First", id: "first", mentions: [], now: createdAt }
  const created = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "thread" })
  const resolved = await store.setStatus(created.id, "resolved", member, 10)
  const replied = await store.addMessage(created.id, { ...message, body: "Reply", id: "reply", now: 10 }, { allowResolved: true })

  expect(replied).toMatchObject({ status: "resolved", resolvedAt: resolved.resolvedAt })
  expect(replied.messages.filter(entry => entry.createdAt > replied.resolvedAt!).map(entry => entry.id)).toEqual(["reply"])
})

it.each([1, 10])("acknowledges every reply when resolving again in the same millisecond (created at %i)", async (createdAt) => {
  const store = setup(defineComments({ authorize: () => true }))
  const message = { attachments: [], author: member, body: "First", id: "first", mentions: [], now: createdAt }
  const created = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "thread" })
  await store.setStatus(created.id, "resolved", member, 10)
  await store.addMessage(created.id, { ...message, body: "Reply", id: "reply", now: 10 }, { allowResolved: true })
  const acknowledged = await store.setStatus(created.id, "resolved", member, 10)

  expect(acknowledged.messages.filter(entry => entry.createdAt > acknowledged.resolvedAt!)).toEqual([])
  const replied = await store.addMessage(created.id, { ...message, body: "Another reply", id: "another", now: 10 }, { allowResolved: true })
  expect(replied.messages.filter(entry => entry.createdAt > replied.resolvedAt!).map(entry => entry.id)).toEqual(["another"])
})

function setup(comments: Comments, users?: CommentsPeople) {
  const store = createCommentsStore(drizzle({ client }))
  installCommentsRuntime({ definition: comments.options, store, ...(users ? { users } : {}) })
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

it("lists page threads with comments.threads, with search, a page filter, and a text line per thread for MCP", async () => {
  setup(defineComments({
    authorize: ({ action, thread }) => action !== "read" || !thread || thread.messages[0]?.body !== "hidden",
    subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })],
  }))
  const pricing = await create(member, { ...input, body: "The price is wrong." })
  await create(member, { ...input, body: "hidden" })
  const home = await create(member, { ...input, body: "Fix the logo.", subject: { id: "/", kind: "page" } })
  await create(member, { ...input, body: "Not a page.", subject: { id: "guide", kind: "doc" } })

  const all = await call("comments.threads", {})
  expect(all).toMatchObject({ ok: true, value: { status: "open", threads: [{ id: home.id }, { id: pricing.id }] } })
  expect(await call("comments.threads", { search: "PRICE" })).toMatchObject({ ok: true, value: { threads: [{ comment: "The price is wrong.", id: pricing.id, page: "/pricing" }] } })
  expect(await call("comments.threads", { page: "/" })).toMatchObject({ ok: true, value: { threads: [{ id: home.id }] } })
  expect(await call("comments.threads", { limit: 1 })).toMatchObject({ ok: true, value: { threads: [{ id: home.id }] } })
  expect(await call("comments.threads", { status: "resolved" })).toEqual({ ok: true, value: { status: "resolved", threads: [] } })

  const format = registry.get("comments.threads")?.mcp
  if (!format || !format.format) throw new TypeError("Expected the MCP format of comments.threads.")
  const text = (format.format as (output: unknown) => string)(all.ok ? all.value : undefined)
  expect(text).toBe(`- #${home.n} ${home.id} /: Fix the logo. (Ana, 0 replies)\n- #${pricing.n} ${pricing.id} /pricing: The price is wrong. (Ana, 0 replies)`)
})

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

it("returns the first thread when create retries with the same requestId", async () => {
  const onComment = vi.fn()
  const store = setup(defineComments({ authorize: () => true, onComment, subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })] }))
  const first = await create(member, { ...input, requestId: "draft-1" })
  const retry = await create(member, { ...input, body: "Review this page, again.", requestId: "draft-1" })
  expect(retry).toEqual(first)
  expect(await store.list({})).toHaveLength(1)
  expect(onComment).toHaveBeenCalledOnce()

  const otherScope = await create(member, { ...input, requestId: "draft-1", subject: { id: "guide", kind: "doc" } })
  expect(otherScope).toMatchObject({ scope: "doc:guide" })
  const withoutKey = await create()
  const againWithoutKey = await create()
  expect(new Set([first.id, otherScope.id, withoutKey.id, againWithoutKey.id]).size).toBe(4)
  expect(await store.list({})).toHaveLength(4)
})

it("refuses a requestId that another author or a hidden thread already uses", async () => {
  const hidden = new Set<string>()
  const store = setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || !hidden.has(thread.id) }))
  const first = await create(member, { ...input, requestId: "draft-1" })
  expect(await call("comments.create", { ...input, requestId: "draft-1" }, admin)).toMatchObject({ ok: false, status: 409, code: "COMMENTS_R0022" })
  hidden.add(first.id)
  expect(await call("comments.create", { ...input, requestId: "draft-1" })).toMatchObject({ ok: false, status: 409, code: "COMMENTS_R0022" })
  expect(await store.list({})).toHaveLength(1)
})

it("refuses a requestId that a thread on another page of the scope already uses", async () => {
  const store = setup(defineComments({ authorize: () => true }))
  const first = await create(member, { ...input, requestId: "draft-1" })
  expect(await call("comments.create", { ...input, requestId: "draft-1", subject: { id: "/docs", kind: "page" } }, member)).toMatchObject({ ok: false, status: 409, code: "COMMENTS_R0022" })
  expect(await store.list({})).toEqual([first])
})

it("returns the first thread to a retry after the author lost write access", async () => {
  let canWrite = true
  setup(defineComments({ authorize: ({ action }) => action !== "write" || canWrite }))
  const first = await create(member, { ...input, requestId: "draft-1" })
  canWrite = false
  expect(await call("comments.create", { ...input, requestId: "draft-1" }, member)).toEqual({ ok: true, value: first })
  expect(await call("comments.create", { ...input, requestId: "draft-2" }, member)).toMatchObject({ ok: false, status: 403 })
})

it("checks read access on the subject before creating a thread", async () => {
  const authorize = vi.fn(({ action }) => action !== "read")
  const store = setup(defineComments({ authorize }))
  expect(await call("comments.create", input)).toMatchObject({ ok: false, status: 403, code: "COMMENTS_R0009" })
  expect(authorize).toHaveBeenCalledExactlyOnceWith({ action: "read", subject: page, user: member })
  expect(await store.list({})).toEqual([])
})

it("checks overlay session permissions for the requested subject", async () => {
  const authorize = vi.fn(({ subject, action }) => subject?.kind === "page" && subject.id.startsWith("/docs/") && (action === "read" || subject.id !== "/docs/readonly"))
  setup(defineComments({ authorize }))
  for (const [id, canRead, canWrite] of [["/docs/intro", true, true], ["/docs/readonly", true, false], ["/pricing", false, false]] as const) {
    expect(await call("comments.session", { subject: { id, kind: "page" } })).toMatchObject({ ok: true, value: { canRead, canWrite, user: { id: member.id } } })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", subject: { id, kind: "page" } }))
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "write", subject: { id, kind: "page" } }))
  }
  expect(await call("comments.session", {})).toMatchObject({ ok: true, value: { canRead: false, canWrite: false } })
  authorize.mockClear()
  expect(await call("comments.session", { subject: page }, null)).toEqual({ ok: true, value: { canRead: false, canWrite: false, user: null } })
  expect(authorize).not.toHaveBeenCalled()
})

it.each([
  ["all", true], [["comments"], true], [["comments:read"], false],
] as const)("reports session write access for %j grants", async (sections, canWrite) => {
  setup(defineComments({ authorize: () => true }))
  const result = await runOperation(registry, "comments.session", { subject: page }, {
    access: { mode: "auth", sections }, user: member,
    development: false, surface: "console", request: new Request("https://example.com/"),
  })
  expect(result).toMatchObject({ ok: true, value: { canRead: true, canWrite } })
})

it("returns only the public session identity", async () => {
  setup(defineComments({ authorize: () => true }))
  const result = await call("comments.session", { subject: page }, { ...member, image: "/ana.png", secret: "private" })
  expect(result).toEqual({ ok: true, value: { canRead: true, canWrite: true, user: { id: member.id, name: member.name, image: "/ana.png" } } })
})

it("checks read access before searching mention suggestions", async () => {
  const search = vi.fn(async () => [member])
  setup(defineComments({ authorize: ({ action }) => action !== "read" }), { byIds: async () => [], search })
  expect(await call("comments.users", { query: "an" })).toMatchObject({ ok: false, status: 403, code: "COMMENTS_R0009" })
  expect(search).not.toHaveBeenCalled()
})

it("keeps the people that the app's search finds without accents or case", async () => {
  const zoe = { id: "zoe", name: "Zoë Ávila" }
  setup(defineComments({ authorize: () => true }), { byIds: async () => [], search: async () => [member, zoe, admin] })
  expect(await call("comments.users", { query: "zoe" })).toEqual({ ok: true, value: [zoe] })
  expect(await call("comments.users", { query: "AVILA" })).toEqual({ ok: true, value: [zoe] })
  expect(await call("comments.users", { query: "zoé" })).toEqual({ ok: true, value: [zoe] })
})

it("returns no threads for an anonymous mine query", async () => {
  setup(defineComments({ authorize: () => true }))
  await create()
  expect(await call("comments.list", {}, null)).toMatchObject({ ok: true, value: [expect.anything()] })
  expect(await call("comments.list", { mine: true }, null)).toEqual({ ok: true, value: [] })
})

it.each(["create", "reply", "edit"])("hides unreadable authors when validating %s mentions", async (operation) => {
  setup(defineComments({ authorize: ({ action, thread, user }) => action !== "read" || !thread || thread.author.id === user?.id }))
  await create(admin)
  const thread = await create()
  const target = operation === "create" ? input : { threadId: thread.id, ...(operation === "edit" ? { messageId: thread.messages[0]!.id } : {}) }
  const value = { ...target, body: "No mention token here." }
  expect(await call(`comments.${operation}`, { ...value, mentions: [admin.id] })).toMatchObject({
    ok: false,
    status: 400,
    message: expect.stringContaining('The mentioned user "admin" does not exist.'),
  })
})

it("resolves mention authors from a readable thread even if they also wrote in a hidden thread", async () => {
  setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || thread.subject.id !== "/hidden" }))
  await create(admin)
  await create({ ...admin, name: "Hidden Admin" }, { ...input, subject: { ...page, id: "/hidden" } })
  expect(await call("comments.create", { ...input, body: "Hello @Admin", mentions: [admin.id] })).toMatchObject({ ok: true })
})

it.each([
  ["(@admin)", true],
  ["Hello @ADMIN!", true],
  ["Hello x@Admin", false],
  ["Hello @Adminée", false],
  ["Hello @Admin_1", false],
])("matches the browser mention boundaries in %s", async (body, allowed) => {
  setup(defineComments({ authorize: () => true }))
  await create(admin)
  const result = await call("comments.create", { ...input, body, mentions: [admin.id] })
  expect(result).toMatchObject(allowed ? { ok: true } : { ok: false, code: "COMMENTS_R0007" })
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
  const users = createAuthUsers(() => ({ $context: Promise.resolve({ internalAdapter: { listUsers: async () => [ben, guest] } }) }))
  setup(defineComments({ authorize: ({ action, user }) => action !== "read" || user?.role === "member", onMention }), users)
  // People that may not read the thread may not be mentioned in it.
  expect(await call("comments.create", { ...input, body: "Hello @Ben and @Guest.", mentions: [ben.id, guest.id] })).toMatchObject({ ok: false, code: "COMMENTS_R0007", message: expect.stringContaining("Guest may not be mentioned here.") })
  const thread = await create(member, { ...input, body: "Hello @Ben.", mentions: [ben.id] })
  await Promise.all(pending)
  expect(onMention).toHaveBeenCalledOnce()
  expect(onMention.mock.calls[0]?.[0]).toEqual({ users: [{ id: ben.id, name: ben.name }], message: thread.messages[0], thread, link: `/pricing?comment=${thread.n}` })
  // Suggestions leave out the people that may not be mentioned, and keep only public fields.
  expect(await call("comments.users", { query: "e" })).toEqual({ ok: true, value: [] })
  expect(await call("comments.users", { query: "be" })).toEqual({ ok: true, value: [{ id: ben.id, name: ben.name }] })
})


it("reports thread actions independently of writing, including ownership and root deletion", async () => {
  const store = setup(defineComments({ authorize: () => true }))
  const thread = await create()
  const mixed = await store.addMessage(thread.id, { author: admin, body: "Admin reply", id: "admin-reply", attachments: [], mentions: [], now: Date.now() })
  await store.addMessage(thread.id, { author: member, body: "My reply", id: "own-reply", attachments: [], mentions: [], now: Date.now() })
  installCommentsRuntime({ definition: defineComments({ authorize: ({ action, thread }) => Boolean(thread) && (action === "read" || action === "resolve") }).options, store })
  expect(await call("comments.session", { threadId: thread.id })).toMatchObject({ ok: true, value: {
    canWrite: false,
    capabilities: { reply: false, resolve: true, deleteThread: false, edit: [thread.messages[0]!.id, "own-reply"], delete: [] },
  } })
  expect(await call("comments.resolve", { threadId: thread.id })).toMatchObject({ ok: true })
  expect(await call("comments.reply", { body: "Denied", threadId: thread.id })).toMatchObject({ ok: false, status: 403 })
  expect(await call("comments.edit", { body: "Allowed", messageId: thread.messages[0]!.id, threadId: thread.id })).toMatchObject({ ok: true })
  expect(await call("comments.delete", { messageId: "own-reply", threadId: thread.id })).toMatchObject({ ok: false, status: 403 })
  expect(await call("comments.delete", { messageId: thread.messages[0]!.id, threadId: thread.id })).toMatchObject({ ok: false, status: 403 })
  expect((await store.getById(mixed.id))?.messages).toHaveLength(3)
})

it("does not grant resolve or delete from write permission and respects operation access", async () => {
  const store = setup(defineComments({ authorize: () => true }))
  const thread = await create(admin)
  installCommentsRuntime({ definition: defineComments({ authorize: ({ action }) => action === "read" || action === "write" }).options, store })
  expect(await call("comments.session", { threadId: thread.id })).toMatchObject({ ok: true, value: {
    capabilities: { reply: true, resolve: false, deleteThread: false, edit: [], delete: [] },
  } })
  installCommentsRuntime({ definition: defineComments({ authorize: () => true }).options, store })
  const result = await runOperation(registry, "comments.session", { threadId: thread.id }, {
    access: { mode: "auth", sections: ["comments:read"] }, user: admin,
    development: false, surface: "console", request: new Request("https://example.com/"),
  })
  expect(result).toMatchObject({ ok: true, value: { capabilities: { reply: false, resolve: false, deleteThread: false, edit: [], delete: [] } } })
  expect(await call("comments.session", { threadId: thread.id }, admin)).toMatchObject({ ok: true, value: { capabilities: { deleteThread: true, delete: [thread.messages[0]!.id], edit: [thread.messages[0]!.id] } } })
})

it.each([false, true])("matches owner deletion capabilities to the write policy (%s)", async write => {
  const store = setup(defineComments({ authorize: () => true }))
  const thread = await create()
  installCommentsRuntime({ definition: defineComments({ authorize: ({ action }) => action !== "write" || write }).options, store })
  expect(await call("comments.session", { threadId: thread.id })).toMatchObject({ ok: true, value: {
    capabilities: { reply: write, deleteThread: write, delete: write ? [thread.messages[0]!.id] : [] },
  } })
  expect(await call("comments.delete", { threadId: thread.id })).toMatchObject(write ? { ok: true } : { ok: false, status: 403 })
})

it.each(["admin", "stranger"])("identifies %s through the standalone CLI operation RPC", async (person) => {
  const identified = { id: "admin", name: "Admin", role: "admin" }
  const authorize = vi.fn(({ user }: { user: CommentsUser | null }) => user?.role === "admin")
  const identify = vi.fn(({ event }: CommentsIdentifyContext) => event["~standard"].req.headers.get("x-person") === "admin" ? identified : null)
  const comments = defineComments({ identify, authorize })
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  installComments(comments, { database: drizzle({ client }) as unknown as CommentsDatabase })
  const handler = createStandaloneOperationHandler([{ operations: commentsOperations, plugin: "comments" }], "/project")
  // `ip` is the loopback peer address that srvx reports for `vite dev`.
  const request = Object.assign(new Request("http://localhost/_vitehub/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vitehub-console": "1", "x-person": person },
    body: operationRpcBody("comments.create", input),
  }), { ip: "127.0.0.1" })
  const response = await handler.fetch(request)
  expect(response.status).toBe(person === "admin" ? 200 : 403)
  expect(operationRpcResult(await response.json())).toMatchObject(person === "admin"
    ? { ok: true, value: { author: { id: "admin", name: "Admin" } } }
    : { ok: false, status: 403 })
  // The RPC passes the Request as the event of the call, and `identify` reads its Standard Context.
  expect(identify).toHaveBeenCalledWith({ event: request })
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ user: person === "admin" ? identified : null }))
})

it("gives authorize the user that identify builds for the request, not the Console user", async () => {
  type DropUser = CommentsUser & { identity?: { role: string } }
  const seen: Array<DropUser | null> = []
  const comments = defineComments({
    // The app's own session: the Console user carries no `identity`.
    identify: ({ event }) => event["~standard"].req.headers.get("x-person") === "admin" ? { id: "admin", name: "Admin", identity: { role: "admin" } } : null,
    authorize: ({ user }) => {
      seen.push(user as DropUser | null)
      return (user as DropUser | null)?.identity?.role === "admin"
    },
  })
  // SAFETY: The libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
  installComments(comments, { database: drizzle({ client }) as unknown as CommentsDatabase })
  const request = new Request("http://site.test/_vitehub/rpc", { headers: { "x-person": "admin" } })
  const context = { access: { mode: "auth", sections: "all" }, surface: "console", user: { id: "admin", name: "Admin" }, request, event: new H3Event(request) } satisfies OperationContext
  const created = await runOperation(registry, "comments.create", input, context)
  expect(created).toMatchObject({ ok: true, value: { author: { id: "admin", name: "Admin" } } })
  expect(await runOperation(registry, "comments.list", {}, context)).toMatchObject({ ok: true, value: [{ id: (created as { value: CommentThread }).value.id }] })
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every(user => user?.identity?.role === "admin")).toBe(true)

  // A call without a request, such as an agent's, has no user for identify to build, so it reads nothing.
  const { event: _event, request: _request, ...agent } = context
  expect(await runOperation(registry, "comments.list", {}, { ...agent, surface: "agent" })).toEqual({ ok: true, value: [] })
  expect(seen.at(-1)).toBeNull()
})
