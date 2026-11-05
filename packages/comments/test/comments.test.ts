import { describe, expect, it, vi } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { defineComments, defineCommentSubject } from "../src/index.ts"
import { ada, anchor, createComments, grace } from "./harness.ts"

describe("defineComments", () => {
  it("starts a thread on a page, replies, resolves, and reopens", async () => {
    const comments = await createComments()
    const [createError, thread] = await comments.create({ page: "/pricing/", anchor, body: "  Typo here  ", author: ada })
    expect(createError).toBeUndefined()
    expect(thread).toMatchObject({ subject: { kind: "page", id: "/pricing" }, scope: "site", n: 1, status: "open", author: ada, messages: [{ body: "Typo here", author: ada }] })

    const [, reply] = await comments.reply(thread!.id, { body: "@Ada fixed", author: grace, mentions: ["ada"] })
    expect(reply).toMatchObject({ threadId: thread!.id, mentions: ["ada"] })

    const [, resolved] = await comments.resolve(thread!.id, { by: grace })
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: grace })
    expect(resolved!.messages).toHaveLength(2)

    const [replyError] = await comments.reply(thread!.id, { body: "One more", author: ada })
    expect(replyError?.code).toBe("COMMENTS_RESOLVED")
    const [, kept] = await comments.reply(thread!.id, { body: "Noted", author: ada }, { allowResolved: true })
    expect(kept?.body).toBe("Noted")
    expect((await comments.get(thread!.id))[1]?.status).toBe("resolved")

    const [, reopened] = await comments.reopen(thread!.id)
    expect(reopened?.status).toBe("open")
    expect(reopened?.resolvedBy).toBeUndefined()
  })

  it("lists by page, subject, scope, and status, newest activity first", async ({ onTestFinished }) => {
    const comments = await createComments({ subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })] })
    // Give each activity a distinct timestamp instead of relying on wall-clock gaps.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 })
    onTestFinished(() => { vi.useRealTimers() })
    const [, first] = await comments.create({ page: "/", anchor, body: "First", author: ada })
    vi.setSystemTime(2_000)
    await comments.create({ page: "/about", anchor, body: "Elsewhere", author: ada })
    vi.setSystemTime(3_000)
    const [, second] = await comments.create({ page: "/", anchor, body: "Second", author: ada })
    vi.setSystemTime(4_000)
    const [, doc] = await comments.create({ subject: { kind: "doc", id: "42" }, body: "On the doc", author: ada })
    vi.setSystemTime(5_000)
    await comments.resolve(second!.id, { by: ada })
    vi.setSystemTime(6_000)
    await comments.reply(first!.id, { body: "Bump", author: grace })

    const [, home] = await comments.list({ page: "/" })
    expect(home!.map(thread => thread.messages[0]!.body)).toEqual(["First", "Second"])
    const [, open] = await comments.list({ page: "/", status: "open" })
    expect(open!.map(thread => thread.id)).toEqual([first!.id])
    expect((await comments.list({ subject: { kind: "doc", id: "42" } }))[1]!.map(thread => thread.id)).toEqual([doc!.id])
    expect((await comments.list({ scope: "doc:42" }))[1]!.map(thread => thread.id)).toEqual([doc!.id])
    expect(doc).toMatchObject({ scope: "doc:42", n: 1, anchor: { kind: "page" } })
  })

  it("removes a thread with its first message, and a reply alone", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Root", author: ada })
    const [, reply] = await comments.reply(thread!.id, { body: "Reply", author: grace })
    expect((await comments.getByMessage(reply!.id))[1]?.id).toBe(thread!.id)
    await comments.removeMessage(reply!.id)
    expect((await comments.get(thread!.id))[1]!.messages).toHaveLength(1)
    await comments.removeMessage(thread!.messages[0]!.id)
    expect((await comments.get(thread!.id))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await comments.removeMessage("missing"))[0]?.code).toBe("COMMENTS_NOT_FOUND")
  })

  it("returns COMMENTS_INVALID_INPUT for an empty body, a bad page, or no subject", async () => {
    const comments = await createComments()
    const [empty] = await comments.create({ page: "/", anchor, body: "   ", author: ada })
    expect(empty).toMatchObject({ code: "COMMENTS_INVALID_INPUT", docs: "https://vitehub.dev/docs/comments/limits-and-errors#comments_invalid_input" })
    const [page] = await comments.create({ subject: { kind: "page", id: "pricing" }, anchor, body: "Hi", author: ada })
    expect(page?.why).toContain("page")
    const [none] = await comments.create({ anchor, body: "Hi", author: ada })
    expect(none?.why).toContain("subject")
  })

  it("returns COMMENTS_NOT_INSTALLED before the server installs a Database", async () => {
    const [error] = await defineComments().list()
    expect(error?.code).toBe("COMMENTS_NOT_INSTALLED")
  })

  it("runs onComment after each saved message, and logs its errors", async () => {
    const onComment = vi.fn()
    const comments = await createComments({ onComment })
    const [, earlier] = await comments.create({ page: "/", anchor, body: "Hello", author: grace })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi @Grace", author: ada, mentions: ["grace"] })
    expect(earlier).toBeDefined()
    expect(onComment).toHaveBeenLastCalledWith(expect.objectContaining({ mentions: [grace], message: expect.objectContaining({ body: "Hi @Grace" }), thread: expect.objectContaining({ id: thread!.id }) }))

    const failing = await createComments({ onComment: () => { throw new Error("mail down") } })
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const [error] = await failing.create({ page: "/", anchor, body: "Still saved", author: ada })
    expect(error).toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it("lets in only vetted people by default, and follows authorize", async () => {
    expect(await defineComments().can({ user: null, action: "read" })).toBe(false)
    // A user of the app's own sign-in waits for a policy in a production build, but not on the dev server.
    expect(await defineComments().can({ user: { id: "ada" }, action: "resolve" })).toBe(false)
    expect(await defineComments().can({ user: { id: "ada" }, action: "resolve" }, { development: true })).toBe(true)
    // The Console admitted them, or GitHub says they can push.
    expect(await defineComments().can({ user: { id: "ada" }, action: "resolve" }, { console: true })).toBe(true)
    expect(await defineComments().can({ user: { id: "ada", github: { login: "ada", write: true } }, action: "delete" })).toBe(true)
    expect(await defineComments().can({ user: null, action: "read" }, { console: true })).toBe(false)
    const editorsOnly = defineComments({ authorize: ({ user, action }) => action === "read" || user?.role === "editor" })
    expect(await editorsOnly.can({ user: null, action: "read" })).toBe(true)
    expect(await editorsOnly.can({ user: { id: "w", role: "writer" }, action: "write" })).toBe(false)
    expect(await editorsOnly.can({ user: { id: "e", role: "editor" }, action: "write" })).toBe(true)
  })

  it("allows only when the policy returns true", async () => {
    // SAFETY: a JavaScript policy may return nothing, which TypeScript forbids.
    const comments = defineComments({ authorize: (({ action }: { action: string }) => action === "read" ? true : undefined) as never })
    const user = { id: "ada" }
    expect(await comments.can({ user, action: "read" })).toBe(true)
    for (const action of ["write", "resolve", "delete"] as const) expect(await comments.can({ user, action })).toBe(false)
  })

  it("suggests earlier authors for @, without guests", async () => {
    const comments = await createComments()
    // Each comment gets its own millisecond, so "newest first" has one order.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000 })
    await comments.create({ page: "/", anchor, body: "Hi", author: ada })
    vi.setSystemTime(2_000)
    await comments.create({ page: "/", anchor, body: "Hi", author: { id: "guest:1", name: "Visitor", guest: true } })
    vi.setSystemTime(3_000)
    await comments.create({ page: "/", anchor, body: "Hi", author: grace })
    vi.useRealTimers()
    expect((await comments.people({ query: "", user: ada }))[1]).toEqual([grace, ada])
    expect((await comments.people({ query: "ad", user: ada }))[1]).toEqual([ada])
  })

  it("keeps a guest a guest, from the id prefix", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", anchor, body: "Hi", author: { id: "guest:1", name: "Visitor" } })
    expect(thread!.author).toEqual({ id: "guest:1", name: "Visitor", guest: true })
    expect((await comments.get(thread!.id))[1]!.messages[0]!.author.guest).toBe(true)
  })

  it("names its schema keys with the vitehub prefix, so they never meet an app's own comments table", () => {
    expect(Object.keys(commentsSchema)).toEqual(["vitehubCommentThreads", "vitehubCommentMessages", "vitehubCommentCounters", "vitehubCommentForge"])
  })
})

describe("thread metadata, page context, and revisions", () => {
  it("keeps metadata and the subject revision, and lists earlier revisions", async () => {
    const comments = await createComments({ subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })] })
    const subject = { kind: "doc", id: "42" }
    const [, v1] = await comments.create({ subject, revision: 1, metadata: { quote: "Hello", x: 12, open: true, note: null }, body: "On v1", author: ada })
    const [, v2] = await comments.create({ subject, revision: 2, body: "On v2", author: ada })
    const [, v3] = await comments.create({ subject, revision: 3, body: "On v3", author: ada })
    await comments.create({ subject, body: "No revision", author: ada })
    expect(v1).toMatchObject({ revision: 1, metadata: { quote: "Hello", x: 12, open: true, note: null } })
    const [, upToTwo] = await comments.list({ subject, revision: { lte: 2 } })
    expect(upToTwo!.map(thread => thread.id).sort()).toEqual([v1!.id, v2!.id].sort())
    expect(v3!.revision).toBe(3)
  })

  it("refuses metadata over the limits, and a revision that is not a whole number", async () => {
    const comments = await createComments()
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`k${index}`, index]))
    expect((await comments.create({ page: "/", metadata: many, body: "Hi", author: ada }))[0]?.why).toContain("50 metadata fields")
    expect((await comments.create({ page: "/", metadata: { long: "x".repeat(4_001) }, body: "Hi", author: ada }))[0]?.code).toBe("COMMENTS_INVALID_INPUT")
    // SAFETY: JavaScript callers can pass any value.
    expect((await comments.create({ page: "/", metadata: { nested: {} as never }, body: "Hi", author: ada }))[0]?.code).toBe("COMMENTS_INVALID_INPUT")
    expect((await comments.create({ page: "/", revision: 1.5, body: "Hi", author: ada }))[0]?.why).toContain("revision")
  })

  it("keeps the page context of a thread", async () => {
    const comments = await createComments()
    const context = { url: "https://example.com/pricing", title: "Pricing", components: [{ name: "PricingCard", files: ["src/PricingCard.vue"] }] }
    const [, thread] = await comments.create({ page: "/pricing", anchor, context, body: "Hi", author: ada })
    expect((await comments.get(thread!.id))[1]!.context).toEqual(context)
  })
})

describe("empty messages", () => {
  it("takes no text when the message has attachments", async () => {
    const comments = await createComments()
    const [, thread] = await comments.create({ page: "/", body: "", attachments: ["comments/a/shot.png"], author: ada })
    expect(thread!.messages[0]).toMatchObject({ body: "", attachments: ["comments/a/shot.png"] })
    const [, reply] = await comments.reply(thread!.id, { body: " ", attachments: ["comments/b/more.png"], author: grace })
    expect(reply).toMatchObject({ body: "", attachments: ["comments/b/more.png"] })
  })

  it("takes no text on a subject that allows it, as the subject's metadata says", async () => {
    const comments = await createComments({
      subjects: [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}`, emptyBody: ({ metadata }) => typeof metadata?.suggestion === "string" })],
    })
    const subject = { kind: "doc", id: "1" }
    const [, suggestion] = await comments.create({ subject, metadata: { suggestion: "Better words" }, body: "", author: ada })
    expect(suggestion!.messages[0]!.body).toBe("")
    expect((await comments.create({ subject, body: "", author: ada }))[0]?.code).toBe("COMMENTS_INVALID_INPUT")
    expect((await comments.reply(suggestion!.id, { body: "", author: grace }))[1]?.body).toBe("")
  })
})
