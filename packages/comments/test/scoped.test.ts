import { H3 } from "h3"
import { describe, expect, it } from "vitest"

import { defineCommentSubject } from "../src/index.ts"
import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, anchor, createComments } from "./harness.ts"

import type { CommentsAuthorizeContext, DefineCommentsOptions } from "../src/types.ts"

const subjects = [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })]
const doc = (id: string) => ({ kind: "doc", id })
const withDocs = (options: DefineCommentsOptions = {}) => createComments({ subjects, ...options })

describe("threads on subjects of the app", () => {
  it("numbers threads in each scope, and keeps the app's metadata", async () => {
    const comments = await withDocs()
    const first = await comments.create({ subject: doc("1"), metadata: { kind: "text", quote: "Hello", ox: 120, outdated: false }, body: "Typo", author: ada })
    const second = await comments.create({ subject: doc("1"), body: "And here", author: ada })
    const other = await comments.create({ subject: doc("2"), body: "Other doc", author: ada })
    const page = await comments.create({ page: "/pricing", anchor, body: "On the page", author: ada })
    expect([first[1]?.n, second[1]?.n, other[1]?.n, page[1]?.n]).toEqual([1, 2, 1, 1])
    expect(first[1]).toMatchObject({ scope: "doc:1", anchor: { kind: "page" }, metadata: { kind: "text", quote: "Hello", ox: 120, outdated: false } })
    expect(page[1]).toMatchObject({ scope: "site" })
    expect(page[1]?.metadata).toBeUndefined()

    const [, list] = await comments.list({ subject: doc("1") })
    expect(list?.map(thread => thread.n).sort()).toEqual([1, 2])
    expect((await comments.getByNumber("doc:1", 2))[1]?.messages[0]?.body).toBe("And here")
    expect((await comments.getByNumber("doc:1", 9))[0]?.code).toBe("COMMENTS_NOT_FOUND")
  })

  it("refuses a subject kind that the app did not define", async () => {
    const comments = await createComments()
    expect((await comments.create({ subject: doc("1"), body: "Hi", author: ada }))[0]?.why).toContain("doc")
  })

  it("edits a message, and removes a whole scope", async () => {
    const comments = await withDocs()
    const [, thread] = await comments.create({ subject: doc("1"), body: "Frist", author: ada })
    const [, edited] = await comments.edit(thread!.messages[0]!.id, { body: "First" })
    expect(edited).toMatchObject({ body: "First", editedAt: expect.any(Number) })
    expect((await comments.edit("missing", { body: "x" }))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    await comments.create({ subject: doc("1"), body: "Second", author: ada })
    await comments.create({ subject: doc("2"), body: "Stays", author: ada })
    expect((await comments.removeScope("doc:1"))[1]).toEqual({ removed: 2 })
    expect((await comments.list({ scope: "doc:1" }))[1]).toEqual([])
    expect((await comments.list({ scope: "doc:2" }))[1]).toHaveLength(1)
  })

  it("suggests only authors of threads that the writer may read, and finds a thread by a message", async () => {
    const comments = await withDocs({ authorize: ({ action, thread, subject, user }) => action !== "read" || (thread?.subject ?? subject)?.kind !== "doc" || user?.id === "cy" })
    const [, onPage] = await comments.create({ page: "/", anchor, body: "Team note", author: ada })
    const [, inDoc] = await comments.create({ subject: doc("1"), body: "Private", author: { id: "cy", name: "Cy" } })
    expect((await comments.people({ query: "", user: ada }))[1]).toEqual([ada])
    expect((await comments.people({ query: "", user: { id: "cy", name: "Cy" }, thread: inDoc! }))[1]).toEqual([{ id: "cy", name: "Cy" }])
    const [, reply] = await comments.reply(inDoc!.id, { body: "Answer", author: ada })
    expect((await comments.getByMessage(reply!.id))[1]?.id).toBe(inDoc!.id)
    expect((await comments.getByMessage(onPage!.messages[0]!.id))[1]?.id).toBe(onPage!.id)
    expect((await comments.getByMessage("missing"))[0]?.code).toBe("COMMENTS_NOT_FOUND")
  })

  it("passes the subject to authorize", async () => {
    const seen: CommentsAuthorizeContext[] = []
    const comments = await withDocs({ authorize: (context) => {
      seen.push(context)
      return context.subject?.kind !== "doc"
    } })
    const [, thread] = await comments.create({ subject: doc("1"), body: "Hi", author: ada })
    expect(await comments.can({ user: { id: "ada" }, action: "read", subject: { kind: "page", id: "/" } })).toBe(true)
    expect(await comments.can({ user: { id: "ada" }, action: "write", thread })).toBe(false)
    expect(seen.map(context => context.subject?.kind)).toEqual(["page", "doc"])
  })

  it("shows threads on other subjects through the Comments API only as authorize allows, and keeps them out of the MCP page tools", async () => {
    // The policy keeps documents to their app routes: no access through the Comments API.
    const comments = await withDocs({ identify: () => ({ id: "ada", name: "Ada" }), authorize: ({ subject }) => subject?.kind !== "doc" })
    const [, scoped] = await comments.create({ subject: doc("1"), body: "Private to the app", author: ada })
    await comments.create({ page: "/", anchor, body: "On the page", author: ada })
    const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
    const call = async (path: string, init: RequestInit = {}) => await (await app.fetch(new Request(`http://site.test/api/_vitehub/comments${path}`, { ...init, headers: { origin: "http://site.test" } }))).json() as { data?: any, error?: { code: string } }
    const listed = await call("/threads")
    expect(listed.data.map((thread: { subject: { kind: string } }) => thread.subject.kind)).toEqual(["page"])
    expect((await call(`/threads/${scoped!.id}/resolve`, { method: "POST" })).error?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await call(`/threads/${scoped!.id}`, { method: "DELETE" })).error?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await call(`/threads/${scoped!.id}`)).data).toBeNull()

    // A policy that lets people read documents opens them through the same routes, for an app's own UI.
    const open = await withDocs({ identify: () => ({ id: "ada", name: "Ada" }), authorize: () => true })
    const [, doc1] = await open.create({ subject: doc("1"), body: "Shared", author: ada })
    const openApp = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments: open, realtime: false }))
    const openList = await (await openApp.fetch(new Request("http://site.test/api/_vitehub/comments/threads?subjectKind=doc&subjectId=1"))).json() as { data: Array<{ id: string }> }
    expect(openList.data.map(thread => thread.id)).toEqual([doc1!.id])

    const tools = Object.fromEntries(commentsMcpTools(open).map(tool => [tool.name, tool]))
    const context = { user: { id: "ada", name: "Ada" }, event: undefined }
    expect((await tools.comments_list_threads!.call({}, context)).text).not.toContain("Shared")
    expect((await tools.comments_get_thread!.call({ id: doc1!.id }, context)).isError).toBe(true)
  })
})
