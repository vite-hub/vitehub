// @vitest-environment node
import { createClient } from "@libsql/client"
import { createOperationRegistry, operationInputJsonSchema, runOperation } from "@vite-hub/internal/operations"
import { drizzle } from "drizzle-orm/libsql"
import { H3Event } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  vi.useRealTimers()
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
  expect(await call("comments.threads", { status: "resolved" })).toEqual({ ok: true, value: { status: "resolved", threads: [], hidden: 0 } })

  const text = threadsText(all)
  expect(text).toBe([
    `- #${home.n} ${home.id} / on the whole page, updated ${minute(home.updatedAt)}: Fix the logo. (Ana, 0 replies)`,
    `- #${pricing.n} ${pricing.id} /pricing on the whole page, updated ${minute(pricing.updatedAt)}: The price is wrong. (Ana, 0 replies)`,
    "",
    "`authorize` hid 1 thread from this caller.",
  ].join("\n"))
})

function minute(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16)}Z`
}

function threadsText(result: Awaited<ReturnType<typeof call>>): string {
  const format = registry.get("comments.threads")?.mcp
  if (!format || !format.format || !result.ok) throw new TypeError("Expected the MCP format of comments.threads and a result.")
  return (format.format as (output: unknown) => string)(result.value)
}

it("filters comments.threads and comments.list by a full URL of the page, and rejects other text", async () => {
  setup(defineComments({ authorize: () => true }))
  const pricing = await create()
  await create(member, { ...input, subject: { id: "/", kind: "page" } })
  const url = "https://drop.vitehub.dev/pricing/?plan=pro#top"
  expect(await call("comments.threads", { page: url })).toMatchObject({ ok: true, value: { threads: [{ id: pricing.id, page: "/pricing" }], hidden: 0 } })
  expect(await call("comments.list", { page: "https://drop.vitehub.dev/pricing" })).toMatchObject({ ok: true, value: [{ id: pricing.id }] })
  for (const page of ["pricing page", "//evil.example/pricing", "ftp://site.test/pricing"]) {
    expect(await call("comments.threads", { page })).toMatchObject({ ok: false, status: 400 })
  }
})

it("says how many threads authorize hid, and never answers \"No open threads.\" then", async () => {
  setup(defineComments({ authorize: ({ action, thread }) => action !== "read" || !thread || thread.messages[0]?.body === "visible" }))
  // Threads list newest first, then by random id. Give each thread its own `updatedAt`, so the order is fixed.
  vi.useFakeTimers({ toFake: ["Date"] })
  let now = Date.UTC(2026, 0, 1)
  const createLater = (...args: Parameters<typeof create>) => {
    vi.setSystemTime(now += 1000)
    return create(...args)
  }
  for (let index = 0; index < 3; index++) await createLater()
  const listed = await call("comments.threads", {})
  expect(listed).toEqual({ ok: true, value: { status: "open", threads: [], hidden: 3, note: "`authorize` hid 3 threads from this caller." } })
  expect(threadsText(listed)).toBe("No open threads that this caller may read. `authorize` hid 3 threads from this caller.")

  // Paging on from the last readable thread counts each hidden thread once.
  const visible = await createLater(member, { ...input, body: "visible" })
  for (let index = 0; index < 2; index++) await createLater()
  expect(await call("comments.threads", { limit: 1 })).toMatchObject({ ok: true, value: { threads: [{ id: visible.id }], hidden: 2 } })
  expect(await call("comments.threads", { search: "nothing" })).toMatchObject({ ok: true, value: { threads: [], hidden: 5 } })
})

it.each([true, false])("gives authorize console: true for comment operations (identify: %s)", async (withIdentify) => {
  const seen: Array<boolean | undefined> = []
  const comments = defineComments({
    ...(withIdentify ? { identify: () => null } : {}),
    authorize: ({ action, console, thread }) => {
      if (thread) seen.push(console)
      return action !== "read" || !thread || console === true
    },
  })
  const store = createCommentsStore(drizzle({ client }))
  installCommentsRuntime({ definition: comments.options, store, ...(withIdentify ? { identify: async () => null } : {}) })
  const message = { attachments: [], author: member, body: "Review this page.", id: "message", mentions: [], now: 1 }
  const thread = await store.createThread({ ...message, anchor: { kind: "page" }, scope: "site", subject: page, threadId: "thread" })
  expect(await call("comments.threads", {}, null)).toMatchObject({ ok: true, value: { threads: [{ id: thread.id }], hidden: 0 } })
  expect(await call("comments.list", {}, null)).toMatchObject({ ok: true, value: [{ id: thread.id }] })
  expect(seen).toEqual([true, true])
})

it("explains that an identify app hides threads from Console calls until authorize allows console", async () => {
  const comments = defineComments({ identify: () => null, authorize: ({ user }) => user !== null })
  const store = createCommentsStore(drizzle({ client }))
  installCommentsRuntime({ definition: comments.options, store, identify: async () => null })
  const message = { attachments: [], author: member, body: "Review this page.", mentions: [], now: 1 }
  for (const id of ["a", "b"]) await store.createThread({ ...message, id, anchor: { kind: "page" }, scope: "site", subject: page, threadId: id })
  const listed = await call("comments.threads", {})
  expect(listed).toMatchObject({ ok: true, value: { threads: [], hidden: 2 } })
  expect(threadsText(listed)).toBe("No open threads that this caller may read. `authorize` hid 2 threads from this caller. With `identify`, a Console call has no app user: allow Console callers in `authorize` with `({ console }) => console`.")
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

it("returns the first message when a reply retries with the same requestId, and announces it once", async () => {
  const ben = { id: "ben", name: "Ben" }
  const onMention = vi.fn()
  const users = createAuthUsers(() => ({ $context: Promise.resolve({ internalAdapter: { listUsers: async () => [ben] } }) }))
  const store = setup(defineComments({ authorize: () => true, onMention }), users)
  const thread = await create()
  const reply = { threadId: thread.id, body: "Fixed, @Ben.", mentions: [ben.id], requestId: "reply-1" }
  const first = await call("comments.reply", reply)
  expect(first.ok).toBe(true)
  expect(await call("comments.reply", { ...reply, body: "Fixed, again." })).toEqual(first)
  expect(await call("comments.reply", reply, admin)).toMatchObject({ ok: false, status: 409, code: "COMMENTS_R0022" })
  expect((await store.getById(thread.id))?.messages.map(message => message.body)).toEqual(["Review this page.", "Fixed, @Ben."])
  await Promise.all(pending)
  expect(onMention).toHaveBeenCalledOnce()

  // Two sends of one reply at once, such as two tabs: the primary key keeps one, and the other gets it back.
  const [a, b] = await Promise.all([call("comments.reply", { ...reply, requestId: "reply-2" }), call("comments.reply", { ...reply, requestId: "reply-2" })])
  expect(a).toEqual(b)
  expect((await store.getById(thread.id))?.messages).toHaveLength(3)
  await Promise.all(pending)
  expect(onMention).toHaveBeenCalledTimes(2)
})

it.each([
  { timing: "before", author: member, requestId: "reply-1", error: undefined },
  { timing: "before", author: admin, requestId: "reply-1", error: "COMMENTS_INVALID_INPUT" },
  { timing: "after", author: member, requestId: "reply-1", error: undefined },
  { timing: "after", author: admin, requestId: "reply-1", error: "COMMENTS_INVALID_INPUT" },
  { timing: "after", author: member, requestId: "reply-2", error: "COMMENTS_RESOLVED" },
])("handles a reply committed and resolved $timing the store read ($author.id, $requestId)", async ({ timing, author, requestId, error }) => {
  const onComment = vi.fn()
  const comments = defineComments({ onComment })
  installComments(comments, { database: drizzle({ client }) })
  const [, thread] = await comments.create({ page: "/pricing", body: "Review this page.", author: member })
  onComment.mockClear()

  const batch = client.batch.bind(client)
  let reads = 0
  const intercepted = vi.spyOn(client, "batch").mockImplementation(async (statements, mode) => {
    const first = statements[0]
    const query = typeof first === "string" ? first : Array.isArray(first) ? first[0] : first?.sql
    if (!query?.startsWith("select") || ++reads !== 2) return batch(statements, mode)
    intercepted.mockRestore()
    const snapshot = timing === "after" ? await batch(statements, mode) : undefined
    const [writeError] = await comments.reply(thread!.id, { body: "Winner", author: member, requestId: "reply-1" })
    expect(writeError).toBeUndefined()
    const [resolveError] = await comments.resolve(thread!.id, { by: member })
    expect(resolveError).toBeUndefined()
    return snapshot ?? batch(statements, mode)
  })

  const [replyError, message] = await comments.reply(thread!.id, { body: "Overlapping reply", author, requestId })
  expect(replyError?.code).toBe(error)
  const [, stored] = await comments.get(thread!.id)
  expect(stored?.status).toBe("resolved")
  expect(stored?.messages.map(entry => entry.body)).toEqual(["Review this page.", "Winner"])
  expect(message).toEqual(error ? undefined : stored?.messages[1])
  expect(onComment).toHaveBeenCalledOnce()
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
  expect(authorize).toHaveBeenCalledExactlyOnceWith({ action: "read", console: true, development: false, subject: page, user: member })
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

describe("guest rate limit", () => {
  /** A guest's call from one address, as the Comments API or the operations RPC passes it. */
  function asGuest(name: string, value: unknown, address = "203.0.113.9") {
    const request = Object.assign(new Request("https://example.com/", { headers: { "x-vitehub-comments-guest-id": "visitor", "x-vitehub-comments-guest-name": "Visitor" } }), { ip: address })
    return runOperation(registry, name, value, { access: { mode: "auth", sections: "all" }, surface: "console", user: null, request })
  }

  it("refuses the write after the limit of a guest address with COMMENTS_GUEST_RATE_LIMITED", async () => {
    setup(defineComments({ authorize: () => true, rateLimit: { limit: 2, window: "1m" } }))
    const first = await asGuest("comments.create", input)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) throw new Error(first.message)
    expect(await asGuest("comments.reply", { threadId: (first.value as CommentThread).id, body: "Again." })).toMatchObject({ ok: true })
    expect(await asGuest("comments.create", input)).toMatchObject({ ok: false, status: 429, code: "COMMENTS_GUEST_RATE_LIMITED" })
    // Another address has its own budget, and signed-in people are not limited.
    expect(await asGuest("comments.create", input, "198.51.100.7")).toMatchObject({ ok: true })
    for (let i = 0; i < 3; i++) await create()
  })

  it("does not count a guest write that the policy refuses", async () => {
    setup(defineComments({ authorize: ({ user, action }) => action === "read" || user !== null, rateLimit: { limit: 1, window: "1m" } }))
    expect(await asGuest("comments.create", input)).toMatchObject({ ok: false, status: 403 })
    expect(await asGuest("comments.create", input)).toMatchObject({ ok: false, status: 403 })
  })

  it("counts guest writes in the shared Rate Limit under the name comments", async () => {
    const calls: unknown[] = []
    const store = createCommentsStore(drizzle({ client }))
    installCommentsRuntime({
      definition: defineComments({ authorize: () => true, rateLimit: { limit: 1, window: "1m" } }).options,
      store,
      rateLimit: async (_request, name, options) => {
        calls.push([name, options])
        return [undefined, calls.length <= options.limit ? { allowed: true } : { allowed: false, reason: "limited", retryAfter: 30 }]
      },
    })
    expect(await asGuest("comments.create", input)).toMatchObject({ ok: true })
    expect(await asGuest("comments.create", input)).toMatchObject({ ok: false, status: 429, code: "COMMENTS_GUEST_RATE_LIMITED" })
    expect(calls[0]).toEqual(["comments", { key: "guest:203.0.113.9", limit: 1, window: "1m" }])
  })

  it("rejects a rateLimit that is not a budget", () => {
    expect(() => defineComments({ rateLimit: { limit: 0, window: "1m" } })).toThrow(expect.objectContaining({ code: "COMMENTS_RATE_LIMIT_INVALID" }))
    expect(() => defineComments({ rateLimit: { limit: 1, window: "0m" } })).toThrow(expect.objectContaining({ code: "COMMENTS_RATE_LIMIT_INVALID" }))
    expect(() => defineComments({ rateLimit: { limit: 5, window: "a minute" } })).toThrow(expect.objectContaining({ code: "COMMENTS_RATE_LIMIT_INVALID" }))
  })
})

it("preserves Console admission for author suggestions and mention writes", async () => {
  setup(defineComments({ authorize: ({ console }) => console === true, canMention: () => true }))
  await create(admin)
  const thread = await create()
  expect(await call("comments.users", { query: "Admin", threadId: thread.id })).toEqual({ ok: true, value: [{ id: admin.id, name: admin.name }] })
  for (const operation of ["create", "reply", "edit"]) {
    const target = operation === "create" ? input : { threadId: thread.id, ...(operation === "edit" ? { messageId: thread.messages[0]!.id } : {}) }
    expect(await call(`comments.${operation}`, { ...target, body: "Hello @Admin", mentions: [admin.id] })).toMatchObject({ ok: true })
  }
})

it("does not give mentioned recipients the writer's Console admission", async () => {
  setup(defineComments({ authorize: ({ console }) => console === true }))
  await create(admin)
  expect(await call("comments.users", { query: "Admin" })).toEqual({ ok: true, value: [] })
  expect(await call("comments.create", { ...input, body: "Hello @Admin", mentions: [admin.id] })).toMatchObject({ ok: false, code: "COMMENTS_R0007" })
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

describe("comments.resolve", () => {
  function agentCall(name: string, value: unknown) {
    return runOperation(registry, name, value, {
      access: { mode: "auth", sections: "all" },
      actor: { id: "claude", label: "Claude" },
      surface: "mcp",
      user: member,
      waitUntil: task => { pending.push(task) },
    })
  }

  it("resolves one thread with a reply that says what changed, and keeps one reply on a retry", async () => {
    const store = setup(defineComments({ authorize: () => true }))
    const thread = await create()
    const request = { reply: "Fixed in 4f9c2e1.", threadId: thread.id }
    const first = await agentCall("comments.resolve", request)
    expect(first).toMatchObject({ ok: true, value: { id: thread.id, resolvedActor: { id: "claude", name: "Claude" }, resolvedBy: { id: member.id }, status: "resolved" } })
    expect(await agentCall("comments.resolve", request)).toMatchObject({ ok: true, value: { status: "resolved" } })
    const stored = await store.getById(thread.id)
    expect(stored?.messages.map(message => message.body)).toEqual(["Review this page.", "Fixed in 4f9c2e1."])
    expect(stored?.messages[1]?.actor).toEqual({ id: "claude", name: "Claude" })
  })

  it("resolves several threads in one call, each with its own reply", async () => {
    const store = setup(defineComments({ authorize: () => true }))
    const [a, b, c] = [await create(), await create(), await create()]
    const result = await call("comments.resolve", { threads: [{ reply: "Done in #12.", threadId: a.id }, { threadId: b.id }] })
    expect(result).toMatchObject({ ok: true, value: [{ id: a.id, status: "resolved" }, { id: b.id, status: "resolved" }] })
    expect((await store.getById(a.id))?.messages.at(-1)?.body).toBe("Done in #12.")
    expect((await store.getById(b.id))?.messages).toHaveLength(1)
    expect((await store.getById(c.id))?.status).toBe("open")
  })

  it("changes no thread when one thread of the call is missing or refused", async () => {
    const store = setup(defineComments({ authorize: ({ action, thread }) => action !== "resolve" || thread?.messages[0]?.body !== "locked" }))
    const open = await create()
    const locked = await create(member, { ...input, body: "locked" })
    expect(await call("comments.resolve", { threads: [{ reply: "Done.", threadId: open.id }, { threadId: "missing" }] })).toMatchObject({ ok: false, status: 404 })
    expect(await call("comments.resolve", { threads: [{ reply: "Done.", threadId: open.id }, { threadId: locked.id }] })).toMatchObject({ ok: false, status: 403 })
    expect(await call("comments.resolve", { threads: [{ reply: "Done.", threadId: open.id }, { reply: " \n", threadId: locked.id }] })).toMatchObject({ ok: false, status: 400 })
    expect(await store.getById(open.id)).toMatchObject({ messages: [{ body: "Review this page." }], status: "open" })
  })

  it.each([undefined, "Fixed the follow-up."])("acknowledges activity after resolution with reply %s", async (reply) => {
    const store = setup(defineComments({ authorize: () => true }))
    const { id: threadId } = await create()
    await call("comments.resolve", { threadId })
    await call("comments.reply", { threadId, body: "One more thing." }, admin)
    const request = { threadId, ...(reply ? { reply } : {}) }
    expect(await call("comments.resolve", request)).toMatchObject({ ok: true })
    expect(await call("comments.resolve", request)).toMatchObject({ ok: true })
    const thread = await store.getById(threadId)
    expect(thread?.messages.map(message => message.body)).toEqual(["Review this page.", "One more thing.", ...(reply ? [reply] : [])])
    expect(thread?.resolvedAt).toBeGreaterThanOrEqual(thread?.messages.at(-1)?.createdAt ?? 0)
  })

  it("accepts the same reply in a later resolution by a different author", async () => {
    const store = setup(defineComments({ authorize: () => true }))
    const { id: threadId } = await create()
    const request = { threadId, reply: "Done." }
    expect(await call("comments.resolve", request)).toMatchObject({ ok: true })
    expect(await call("comments.reopen", { threadId }, admin)).toMatchObject({ ok: true })
    expect(await call("comments.resolve", request, admin)).toMatchObject({ ok: true })
    expect((await store.getById(threadId))?.messages.filter(message => message.body === "Done.").map(message => message.author.id)).toEqual([member.id, admin.id])
  })

  it("does not check write policy again after changing a thread in the batch", async () => {
    let resolvedFirst = false
    const store = setup(defineComments({ authorize: ({ action }) => action !== "write" || !resolvedFirst }))
    const first = await create()
    const second = await create()
    const setStatus = store.setStatus.bind(store)
    vi.spyOn(store, "setStatus").mockImplementation(async (...args) => {
      const result = await setStatus(...args)
      if (result.id === first.id) resolvedFirst = true
      return result
    })
    expect(await call("comments.resolve", { threads: [{ threadId: first.id }, { threadId: second.id, reply: "Done." }] })).toMatchObject({ ok: true })
  })

  it("reports completed threads when a batch write stops", async () => {
    const store = setup(defineComments({ authorize: () => true }))
    const first = await create()
    const second = await create()
    const setStatus = store.setStatus.bind(store)
    vi.spyOn(store, "setStatus").mockImplementation((...args) => args[0] === second.id ? Promise.reject(new Error("Store unavailable")) : setStatus(...args))
    expect(await call("comments.resolve", { threads: [{ threadId: first.id }, { threadId: second.id, reply: "Done." }] })).toMatchObject({
      ok: false, code: "COMMENTS_RESOLVE_INTERRUPTED", message: expect.stringContaining(`after its reply was saved. Completed threads: ${JSON.stringify(first.id)}`),
    })
  })

  it("takes either threadId or threads, and keeps each reply in its entry", async () => {
    setup(defineComments({ authorize: () => true }))
    const thread = await create()
    for (const value of [{}, { threadId: thread.id, threads: [{ threadId: thread.id }] }, { reply: "Done.", threads: [{ threadId: thread.id }] }, { threads: [] }]) {
      expect(await call("comments.resolve", value)).toMatchObject({ ok: false, status: 400 })
    }
    expect(await call("comments.resolve", { threads: [{ threadId: thread.id }, { threadId: thread.id }] })).toMatchObject({ ok: false, status: 400 })
    expect(operationInputJsonSchema(registry.get("comments.resolve")!)).toMatchObject({ anyOf: [
      { required: ["threadId"], additionalProperties: false },
      { required: ["threads"], additionalProperties: false },
    ] })
  })

  it("tells the agent to resolve the open threads that it handles", async () => {
    setup(defineComments({ authorize: () => true }))
    await create()
    expect(await call("comments.threads", {})).toMatchObject({ ok: true, value: { next: expect.stringContaining("comments.resolve") } })
    const resolved = await call("comments.threads", { status: "resolved" })
    expect(resolved).toMatchObject({ ok: true, value: { threads: [] } })
    expect(resolved.ok && resolved.value).not.toHaveProperty("next")
  })

  it("gets a thread by its threadId, as the other operations name it", async () => {
    setup(defineComments({ authorize: () => true }))
    const thread = await create()
    expect(await call("comments.get", { threadId: thread.id })).toMatchObject({ ok: true, value: { id: thread.id } })
    expect(await call("comments.get", { id: thread.id })).toMatchObject({ message: expect.stringContaining("comments.get takes { threadId } or { n, scope }."), ok: false, status: 400 })
    expect(await call("comments.resolve", {})).toMatchObject({ message: expect.stringContaining("comments.resolve takes { threadId, reply? } or { threads }."), ok: false })
  })
})
