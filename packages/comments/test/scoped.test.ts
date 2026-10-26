import { H3 } from "h3"
import { describe, expect, it } from "vitest"

import { commentsMcpTools } from "../src/runtime/mcp.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, anchor, createComments } from "./harness.ts"

import type { CommentsAuthorizeContext } from "../src/types.ts"

describe("scoped threads", () => {
  it("numbers threads in each scope, and keeps the app's metadata", async () => {
    const comments = await createComments()
    const first = await comments.create({ scope: "doc:1", page: "/d/1", metadata: { kind: "text", quote: "Hello", ox: 120, outdated: false }, body: "Typo", author: ada })
    const second = await comments.create({ scope: "doc:1", page: "/d/1", body: "And here", author: ada })
    const other = await comments.create({ scope: "doc:2", page: "/d/2", body: "Other doc", author: ada })
    const page = await comments.create({ page: "/pricing", anchor, body: "On the page", author: ada })
    expect([first[1]?.number, second[1]?.number, other[1]?.number, page[1]?.number]).toEqual([1, 2, 1, 1])
    expect(first[1]).toMatchObject({ scope: "doc:1", anchor: null, metadata: { kind: "text", quote: "Hello", ox: 120, outdated: false } })
    expect(page[1]).toMatchObject({ scope: "pages", metadata: null })

    const [, list] = await comments.list({ scope: "doc:1" })
    expect(list?.map(thread => thread.number).sort()).toEqual([1, 2])
    expect((await comments.getByNumber("doc:1", 2))[1]?.comments[0]?.body).toBe("And here")
    expect((await comments.getByNumber("doc:1", 9))[0]?.code).toBe("COMMENTS_NOT_FOUND")
  })

  it("needs an anchor for a page thread, and checks metadata", async () => {
    const comments = await createComments()
    expect((await comments.create({ page: "/", body: "No anchor", author: ada }))[0]?.code).toBe("COMMENTS_INVALID_INPUT")
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index]))
    expect((await comments.create({ scope: "doc:1", page: "/", metadata: many, body: "Hi", author: ada }))[0]?.code).toBe("COMMENTS_INVALID_INPUT")
  })

  it("edits a comment, and removes a whole scope", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ scope: "doc:1", page: "/d/1", body: "Frist", author: ada })
    const [, edited] = await comments.edit(thread!.comments[0]!.id, { body: "First" })
    expect(edited).toMatchObject({ body: "First", editedAt: expect.any(String) })
    expect((await comments.edit("missing", { body: "x" }))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    await comments.create({ scope: "doc:1", page: "/d/1", body: "Second", author: ada })
    await comments.create({ scope: "doc:2", page: "/d/2", body: "Stays", author: ada })
    expect((await comments.removeScope("doc:1"))[1]).toEqual({ removed: 2 })
    expect((await comments.list({ scope: "doc:1" }))[1]).toEqual([])
    expect((await comments.list({ scope: "doc:2" }))[1]).toHaveLength(1)
  })

  it("passes the scope to authorize", async () => {
    const seen: CommentsAuthorizeContext[] = []
    const comments = await createComments({ authorize: (context) => {
      seen.push(context)
      return context.scope === "pages"
    } })
    const [, thread] = await comments.create({ scope: "doc:1", page: "/", body: "Hi", author: ada })
    expect(await comments.can({ user: { id: "ada" }, action: "read" })).toBe(true)
    expect(await comments.can({ user: { id: "ada" }, action: "comment", thread })).toBe(false)
    expect(seen.map(context => context.scope)).toEqual(["pages", "doc:1"])
  })

  it("keeps threads of other scopes out of the page API and the MCP tools", async () => {
    const comments = await createComments({ identify: () => ({ id: "ada", name: "Ada" }) })
    const [, scoped] = await comments.create({ scope: "doc:1", page: "/", body: "Private to the app", author: ada })
    await comments.create({ page: "/", anchor, body: "On the page", author: ada })
    const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
    const call = async (path: string, init: RequestInit = {}) => await (await app.fetch(new Request(`http://site.test/api/_vitehub/comments${path}`, { ...init, headers: { origin: "http://site.test" } }))).json() as { data?: any, error?: { code: string } }
    const listed = await call("/threads?page=/")
    expect(listed.data.map((thread: { scope: string }) => thread.scope)).toEqual(["pages"])
    expect((await call(`/threads/${scoped!.id}/resolve`, { method: "POST" })).error?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await call(`/threads/${scoped!.id}`, { method: "DELETE" })).error?.code).toBe("COMMENTS_NOT_FOUND")

    const tools = Object.fromEntries(commentsMcpTools(comments).map(tool => [tool.name, tool]))
    const context = { user: { id: "ada", name: "Ada" }, event: undefined }
    expect((await tools.comments_list_threads!.call({}, context)).text).not.toContain("Private to the app")
    expect((await tools.comments_get_thread!.call({ id: scoped!.id }, context)).isError).toBe(true)
  })
})
