import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { ada, anchor, createComments, grace } from "./harness.ts"

describe("defineComments", () => {
  it("starts a thread, replies, resolves, and reopens", async () => {
    const comments = await createComments()
    const [createError, thread] = await comments.create({ page: "/pricing/", anchor, body: "  Typo here  ", author: ada })
    expect(createError).toBeUndefined()
    expect(thread).toMatchObject({ page: "/pricing", status: "open", createdBy: ada, comments: [{ body: "Typo here", author: ada }] })

    const [, reply] = await comments.reply(thread!.id, { body: "@Ada fixed", author: grace, mentions: [{ id: "ada", name: "Ada" }] })
    expect(reply).toMatchObject({ threadId: thread!.id, mentions: [{ id: "ada", name: "Ada" }] })

    const [, resolved] = await comments.resolve(thread!.id, { by: grace })
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: grace })
    expect(resolved!.comments).toHaveLength(2)

    const [replyError] = await comments.reply(thread!.id, { body: "One more", author: ada })
    expect(replyError?.code).toBe("COMMENTS_RESOLVED")

    const [, reopened] = await comments.reopen(thread!.id)
    expect(reopened).toMatchObject({ status: "open", resolvedBy: null, resolvedAt: null })
  })

  it("lists by page and status, newest activity first", async () => {
    const comments = await createComments()
    const [, first] = await comments.create({ page: "/", anchor, body: "First", author: ada })
    await comments.create({ page: "/about", anchor, body: "Elsewhere", author: ada })
    const [, second] = await comments.create({ page: "/", anchor, body: "Second", author: ada })
    await comments.resolve(second!.id, { by: ada })
    await comments.reply(first!.id, { body: "Bump", author: grace })

    const [, home] = await comments.list({ page: "/" })
    expect(home!.map(thread => thread.comments[0]!.body)).toEqual(["First", "Second"])
    const [, open] = await comments.list({ page: "/", status: "open" })
    expect(open!.map(thread => thread.id)).toEqual([first!.id])
  })

  it("removes a thread with its first comment, and a reply alone", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Root", author: ada })
    const [, reply] = await comments.reply(thread!.id, { body: "Reply", author: grace })
    await comments.removeComment(reply!.id)
    expect((await comments.get(thread!.id))[1]!.comments).toHaveLength(1)
    await comments.removeComment(thread!.comments[0]!.id)
    expect((await comments.get(thread!.id))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await comments.removeComment("missing"))[0]?.code).toBe("COMMENTS_NOT_FOUND")
  })

  it("returns COMMENTS_INVALID_INPUT for an empty body or a bad page", async () => {
    const comments = await createComments()
    const [empty] = await comments.create({ page: "/", anchor, body: "   ", author: ada })
    expect(empty).toMatchObject({ code: "COMMENTS_INVALID_INPUT", docs: "https://vitehub.dev/docs/comments/limits-and-errors#comments_invalid_input" })
    const [page] = await comments.create({ page: "pricing", anchor, body: "Hi", author: ada })
    expect(page?.why).toContain("page")
  })

  it("returns COMMENTS_NOT_INSTALLED before the server installs a Database", async () => {
    const [error] = await defineComments().list()
    expect(error?.code).toBe("COMMENTS_NOT_INSTALLED")
  })

  it("runs onComment after each saved comment, and logs its errors", async () => {
    const onComment = vi.fn()
    const comments = await createComments({ onComment })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi @Grace", author: ada, mentions: [grace] })
    expect(onComment).toHaveBeenCalledWith(expect.objectContaining({ mentions: [grace], comment: expect.objectContaining({ body: "Hi @Grace" }) }))

    const failing = await createComments({ onComment: () => { throw new Error("mail down") } })
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const [error] = await failing.create({ page: "/", anchor, body: "Still saved", author: ada })
    expect(error).toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
    expect(thread).toBeDefined()
  })

  it("lets signed-in users act by default, and follows authorize", async () => {
    expect(await defineComments().can({ user: null, action: "read" })).toBe(false)
    expect(await defineComments().can({ user: { id: "ada" }, action: "resolve" })).toBe(true)
    const editorsOnly = defineComments({ authorize: ({ user, action }) => action === "read" || user?.role === "editor" })
    expect(await editorsOnly.can({ user: null, action: "read" })).toBe(true)
    expect(await editorsOnly.can({ user: { id: "w", role: "writer" }, action: "comment" })).toBe(false)
    expect(await editorsOnly.can({ user: { id: "e", role: "editor" }, action: "comment" })).toBe(true)
  })

  it("suggests earlier authors for @, without guests", async () => {
    const comments = await createComments()
    await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    await comments.create({ page: "/", anchor, body: "Hi", author: { id: "guest:1", name: "Visitor", guest: true } })
    await comments.create({ page: "/", anchor, body: "Hi", author: grace })
    expect((await comments.people({ query: "", user: null }))[1]).toEqual([grace, ada])
    expect((await comments.people({ query: "ad", user: null }))[1]).toEqual([ada])
  })
})
