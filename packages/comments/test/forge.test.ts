import { Window } from "happy-dom"
import { marked } from "marked"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { createGitHubClient } from "../src/forge/github.ts"
import { renderComment, renderSummary, unlinked } from "../src/forge/render.ts"
import { defineComments, installComments } from "../src/index.ts"
import { createCommentsStore } from "../src/store.ts"
import { ada, anchor, createComments, createDatabase, grace } from "./harness.ts"

import type { CommentContext, CommentsForgeOptions, CommentThread } from "../src/types.ts"

interface FakeComment {
  id: number
  body: string
  token: string
  minimized: boolean
  pullRequest: number
}

/** Enough of GitHub's REST and GraphQL API for the sync: issue comments, pull requests by head, and minimizing. */
function fakeGitHub(pulls: Record<string, number> = {}) {
  const comments = new Map<number, FakeComment>()
  const calls: string[] = []
  let nextId = 100
  let failNext = 0
  const rejectedTokens = new Map<string, number>()
  let rejectedCreate: "summary" | "comment" | undefined
  let lostResponse: "summary" | "comment" | undefined
  let heldCreate: { kind: "summary" | "comment", visible: boolean, started: () => void, released: Promise<void> } | undefined
  let heldUpdate: { kind: "summary" | "comment" | "visibility", started: () => void, released: Promise<void> } | undefined
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? ""
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${method} ${url.pathname}`)
    const json = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
    if (rejectedTokens.has(token)) return json({ message: "Token rejected" }, rejectedTokens.get(token))
    if (failNext > 0) {
      failNext--
      return json({ message: "Resource not accessible by integration" }, 403)
    }
    if (url.pathname === "/graphql") {
      const { query, variables } = body as { query: string, variables: { id: string } }
      const comment = comments.get(Number(variables.id.replace("node-", "")))
      if (heldUpdate?.kind === "visibility") {
        const held = heldUpdate
        heldUpdate = undefined
        held.started()
        await held.released
      }
      if (comment) comment.minimized = query.includes("minimizeComment(") && !query.includes("unminimize")
      return json({ data: {} })
    }
    let match = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(url.pathname)
    if (match && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1)
      const pullRequest = Number(match[1])
      return json([...comments.values()].filter(comment => comment.pullRequest === pullRequest)
        .slice((page - 1) * 100, page * 100)
        .map(comment => ({ id: comment.id, node_id: `node-${comment.id}`, html_url: `https://github.com/acme/app/pull/${comment.pullRequest}#issuecomment-${comment.id}`, body: comment.body })))
    }
    if (match && method === "POST") {
      const id = nextId++
      const text = (body as { body: string }).body
      const kind = text.endsWith("<!-- vitehub-comments summary -->") ? "summary" : "comment"
      if (rejectedCreate === kind) {
        rejectedCreate = undefined
        return json({ message: "Resource not accessible by integration" }, 403)
      }
      const comment = { id, body: text, token, minimized: false, pullRequest: Number(match[1]) }
      if (heldCreate?.kind !== kind || heldCreate.visible) comments.set(id, comment)
      if (heldCreate?.kind === kind) {
        const held = heldCreate
        heldCreate = undefined
        held.started()
        await held.released
        comments.set(id, comment)
      }
      if (lostResponse === kind) {
        lostResponse = undefined
        throw new TypeError("Connection lost after GitHub accepted the comment")
      }
      return json({ id, node_id: `node-${id}`, html_url: `https://github.com/acme/app/pull/${match[1]}#issuecomment-${id}` }, 201)
    }
    match = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(url.pathname)
    if (match) {
      const comment = comments.get(Number(match[1]))
      if (!comment) return json({ message: "Not Found" }, 404)
      if (method === "PATCH") {
        const kind = comment.body.endsWith("<!-- vitehub-comments summary -->") ? "summary" : "comment"
        if (heldUpdate?.kind === kind) {
          const held = heldUpdate
          heldUpdate = undefined
          held.started()
          await held.released
        }
        comment.body = (body as { body: string }).body
      }
      if (method === "DELETE") comments.delete(comment.id)
      return method === "DELETE" ? json(null, 204) : json({ id: comment.id })
    }
    if (url.pathname === "/repos/acme/app/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1] ?? ""
      return json(pulls[head] ? [{ number: pulls[head] }] : [])
    }
    return json({ message: `Unexpected ${method} ${url.pathname}` }, 500)
  })
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    comments,
    calls,
    failNextRequests(count: number) {
      failNext = count
    },
    rejectToken(token: string, status: number) {
      rejectedTokens.set(token, status)
    },
    rejectNextCreate(kind: "summary" | "comment") {
      rejectedCreate = kind
    },
    loseNextCreateResponse(kind: "summary" | "comment") {
      lostResponse = kind
    },
    holdNextUpdate(kind: "summary" | "comment" | "visibility") {
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { start = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      heldUpdate = { kind, started: start, released }
      return { started, release }
    },
    holdNextCreate(kind: "summary" | "comment", visible = true) {
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { start = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      heldCreate = { kind, visible, started: start, released }
      return { started, release }
    },
    bodies: () => [...comments.values()].map(comment => comment.body),
  }
}

function context(build: CommentContext["build"] = { repository: "acme/app", pullRequest: 7, branch: "feat/filters" }): CommentContext {
  return {
    url: "https://pr7.preview.acme.dev/forecast?group=eu",
    route: "/forecast",
    element: { tag: "button", role: "button", name: "Q4 EU promotions" },
    components: [{ name: "BookmarkSelector", files: ["app/components/BookmarkSelector.vue"] }],
    build,
  }
}

async function forgeComments(github: ReturnType<typeof fakeGitHub>, forge: Partial<CommentsForgeOptions> = {}) {
  return await createComments({ forge: { provider: "github", fetch: github.fetch, ...forge } })
}

describe("forge sync", () => {
  beforeEach(() => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "app-token")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("posts the summary first, then the thread for its author, and links them", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Bookmark names are cut off. Show them in full.", author: ada })
    await comments.flush()

    const [summary, posted] = [...github.comments.values()]
    expect(summary!.body).toContain("### Preview comments")
    expect(summary!.body).toContain(`[Bookmark names are cut off.](https://github.com/acme/app/pull/7#issuecomment-${posted!.id})`)
    expect(summary!.body).toContain("**1 open**, 0 resolved on [pr7.preview.acme.dev](https://pr7.preview.acme.dev)")
    expect(posted!.body).toContain("**Ada** commented on the preview:\n\n> Bookmark names are cut off. Show them in full.")
    expect(posted!.body).toContain("`app/components/BookmarkSelector.vue`")
    expect(posted!.body).toContain(`https://pr7.preview.acme.dev/forecast?group=eu&comments#comment-${thread!.id}`)
    expect(posted!.token).toBe("app-token")

    const [, read] = await comments.get(thread!.id)
    expect(read!.forge).toEqual({ repository: "acme/app", pullRequest: 7, state: "posted", url: `https://github.com/acme/app/pull/7#issuecomment-${posted!.id}`, postedAs: "app" })
  })

  it("posts as the person with their token, and as the app for people without one", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github, { token: author => author.id === "ada" ? "ada-token" : undefined })
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.reply(thread!.id, { body: "Agreed.", author: grace })
    await comments.flush()

    const [, first, reply] = [...github.comments.values()]
    expect(first).toMatchObject({ token: "ada-token" })
    expect(first!.body.startsWith("Cut off.\n\n**#⁠1** on")).toBe(true)
    expect(reply).toMatchObject({ token: "app-token" })
    expect(reply!.body).toContain("**Grace** replied on #⁠1:\n\n> Agreed.")
  })

  it("attaches pending, posted, and failed forge state when looking up a comment", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const held = github.holdNextCreate("comment")
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    const id = thread!.comments[0]!.id
    await held.started
    const [, pending] = await comments.getByComment(id)
    held.release()
    await comments.flush()
    const [, posted] = await comments.getByComment(id)
    github.failNextRequests(1)
    await comments.edit(id, { body: "Edited." })
    await comments.flush()
    const [, failed] = await comments.getByComment(id)

    expect(pending!.forge).toMatchObject({ state: "pending" })
    expect(posted!.forge).toMatchObject({ state: "posted", url: expect.any(String) })
    expect(failed!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403") })
  })

  it("aggregates pending and failed replies while keeping the first comment's link", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    await comments.flush()
    const original = (await comments.get(thread!.id))[1]!.forge!
    const held = github.holdNextCreate("comment")
    const [, reply] = await comments.reply(thread!.id, { body: "A reply.", author: grace })
    await held.started
    const pending = (await comments.get(thread!.id))[1]!.forge
    held.release()
    await comments.flush()
    expect(pending).toMatchObject({ state: "pending", url: original.url, postedAs: original.postedAs })

    github.failNextRequests(1)
    await comments.edit(reply!.id, { body: "An edited reply." })
    await comments.flush()
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403"), url: original.url })
    expect((await comments.list({ page: "/forecast" }))[1]![0]!.forge).toMatchObject({ state: "failed" })
    expect(github.bodies()[0]).toContain("Open, not posted yet")

    await comments.sync(thread!.id)
    expect((await comments.getByComment(reply!.id))[1]!.forge).toEqual(original)
    expect(github.bodies()[0]).not.toContain("not posted yet")
  })

  it("exposes a rejected reply create in the thread and summary until retry", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    await comments.flush()
    github.rejectNextCreate("comment")
    await comments.reply(thread!.id, { body: "A reply.", author: grace })
    await comments.flush()
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403"), url: expect.any(String) })
    expect(github.bodies()[0]).toContain("Open, not posted yet")
    await comments.sync(thread!.id)
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "posted" })
    expect(github.comments.size).toBe(3)
  })

  it.each([401, 403, 404])("retries author edits with the app after token rejection (%s)", async (status) => {
    const github = fakeGitHub()
    const comments = await forgeComments(github, { token: () => "ada-token" })
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    await comments.flush()
    github.rejectToken("ada-token", status)
    await comments.edit(thread!.comments[0]!.id, { body: "Edited." })
    await comments.flush()
    expect(github.bodies()[1]).toMatch(/^Edited\./)
    expect(github.comments.size).toBe(2)
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "posted", postedAs: "author" })

    github.rejectToken("app-token", 403)
    await comments.edit(thread!.comments[0]!.id, { body: "Rejected by both." })
    await comments.flush()
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403") })
  })

  it("hides a resolved thread, shows it again when reopened, and keeps the summary current", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.flush()
    const [summary, posted] = [...github.comments.values()]

    await comments.resolve(thread!.id, { by: grace })
    await comments.flush()
    expect(posted!.minimized).toBe(true)
    expect(summary!.body).toContain("**0 open**, 1 resolved")
    expect(summary!.body).toMatch(/~~\[Cut off\.\]\(.+\)~~.+\| Resolved \|/)

    await comments.reopen(thread!.id)
    await comments.flush()
    expect(posted!.minimized).toBe(false)
    expect(summary!.body).toContain("**1 open**")
  })

  it.each(["resolve", "reopen"] as const)("keeps the latest status when an older %s finishes last in another isolate", async (action) => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const first = defineComments(options)
    const second = defineComments(options)
    installComments(first, { database })
    installComments(second, { database })
    const [, thread] = await first.create({ page: "/forecast", anchor, context: context(), body: "Visibility.", author: ada })
    await first.flush()
    if (action === "reopen") {
      await first.resolve(thread!.id, { by: grace })
      await first.flush()
    }
    const posted = [...github.comments.values()][1]!
    const held = github.holdNextUpdate("visibility")
    if (action === "resolve") await first.resolve(thread!.id, { by: grace })
    else await first.reopen(thread!.id)
    await held.started
    if (action === "resolve") await second.reopen(thread!.id)
    else await second.resolve(thread!.id, { by: grace })
    await second.flush()
    held.release()
    await first.flush()

    expect(posted.minimized).toBe(action === "reopen")
    expect((await second.get(thread!.id))[1]!.status).toBe(action === "reopen" ? "resolved" : "open")
    github.calls.length = 0
    await second.sync(thread!.id)
    expect(github.calls).toEqual([])
  })

  it("edits only the comment that changed, and sends nothing when nothing did", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.flush()
    github.calls.length = 0

    await comments.sync(thread!.id)
    expect(github.calls).toEqual([])

    await comments.edit(thread!.comments[0]!.id, { body: "Cut off at 24 characters." })
    await comments.flush()
    expect(github.calls.filter(call => call.startsWith("PATCH"))).toHaveLength(2)
    expect(github.bodies().join("\n")).toContain("Cut off at 24 characters.")
  })

  it.each(["resolve", "reopen"] as const)("exposes a rejected %s and clears the failure after retry", async (action) => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Visibility.", author: ada })
    await comments.flush()
    if (action === "reopen") {
      await comments.resolve(thread!.id, { by: grace })
      await comments.flush()
    }
    const posted = [...github.comments.values()][1]!
    github.failNextRequests(1)
    if (action === "resolve") await comments.resolve(thread!.id, { by: grace })
    else await comments.reopen(thread!.id)
    await comments.flush()

    expect(posted.minimized).toBe(action === "reopen")
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("GraphQL"), url: expect.any(String) })
    await comments.sync(thread!.id)
    expect(posted.minimized).toBe(action === "resolve")
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "posted" })
    expect((await comments.get(thread!.id))[1]!.forge).not.toHaveProperty("error")
  })

  it("deletes the comments of a deleted thread, and the summary with the last one", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, first] = await comments.create({ page: "/forecast", anchor, context: context(), body: "One.", author: ada })
    const [, second] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Two.", author: grace })
    await comments.reply(second!.id, { body: "Reply.", author: ada })
    await comments.flush()
    expect(github.comments.size).toBe(4)

    await comments.remove(second!.id)
    await comments.flush()
    expect(github.comments.size).toBe(2)
    expect(github.bodies()[0]).not.toContain("Two.")

    await comments.remove(first!.id)
    await comments.flush()
    expect(github.comments.size).toBe(0)
  })

  it("shows a refused thread as failed, and posts it on the next sync", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    github.rejectNextCreate("comment")
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.flush()

    const [, failed] = await comments.get(thread!.id)
    expect(failed!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403") })

    await comments.sync(thread!.id)
    const [, posted] = await comments.get(thread!.id)
    expect(posted!.forge).toMatchObject({ state: "posted" })
    expect(github.bodies().some(body => body.includes("> Cut off."))).toBe(true)
  })

  it.each(["summary", "comment"] as const)("adopts a %s whose create response was lost", async (kind) => {
    const github = fakeGitHub()
    const comments = await forgeComments(github, { token: () => "ada-token" })
    github.loseNextCreateResponse(kind)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Before retry.", author: ada })
    await comments.flush()

    // Recovery must adopt the stored body and still apply an edit made before the retry.
    await comments.edit(thread!.comments[0]!.id, { body: "After retry." })
    await comments.flush()
    await comments.sync(thread!.id)
    expect(github.comments.size).toBe(2)
    expect(github.calls.filter(call => call === "POST /repos/acme/app/issues/7/comments")).toHaveLength(2)
    expect(github.bodies().join("\n")).toContain("After retry.")
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "posted", postedAs: "author" })
  })

  it.each(["summary", "comment"] as const)("cleans up deletion from another isolate during a %s create", async (kind) => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const posting = defineComments(options)
    const deleting = defineComments(options)
    installComments(posting, { database })
    installComments(deleting, { database })
    const held = github.holdNextCreate(kind)
    const [, thread] = await posting.create({ page: "/forecast", anchor, context: context(), body: "Deleted during posting.", author: ada })
    await held.started
    await deleting.remove(thread!.id)
    await deleting.flush()
    held.release()
    await posting.flush()

    expect(github.comments.size).toBe(0)
    expect(await database.select().from(commentsSchema.vitehubCommentForge)).toEqual([])
  })

  it("removes every forge comment and row in a scope with more than 500 threads", async () => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const store = createCommentsStore(database)
    const links = []
    for (let index = 0; index < 501; index++) {
      const thread = await store.create({ scope: "doc:1", page: "/forecast", context: context(), body: `Thread ${index}.`, author: ada, mentions: [] })
      const id = 1000 + index
      github.comments.set(id, { id, body: "Existing comment", token: "app-token", minimized: false, pullRequest: 7 })
      links.push({ id: thread.comments[0]!.id, threadId: thread.id, repository: "acme/app", pullRequest: 7, remoteId: String(id), updatedAt: Date.now() })
    }
    await database.insert(commentsSchema.vitehubCommentForge).values(links)
    const comments = defineComments({ forge: { provider: "github", fetch: github.fetch } })
    installComments(comments, { database })

    expect((await comments.removeScope("doc:1"))[1]).toEqual({ removed: 501 })
    await comments.flush()
    expect(github.comments.size).toBe(0)
    expect(await database.select().from(commentsSchema.vitehubCommentForge)).toEqual([])
  })

  it.each([
    { kind: "summary", remove: false },
    { kind: "comment", remove: false },
    { kind: "summary", remove: true },
    { kind: "comment", remove: true },
  ] as const)("reconciles an expired $kind create (delete: $remove)", async ({ kind, remove }) => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const first = defineComments(options)
    const second = defineComments(options)
    installComments(first, { database })
    installComments(second, { database })
    const held = github.holdNextCreate(kind, false)
    const [, thread] = await first.create({ page: "/forecast", anchor, context: context(), body: "Late create.", author: ada })
    await held.started
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000)
    if (remove) {
      await second.remove(thread!.id)
      // A summary has no thread row yet, so explicitly finish its expired cleanup too.
      await second.flush()
    }
    else {
      await second.sync(thread!.id)
    }
    const before = await database.select().from(commentsSchema.vitehubCommentForge)
    held.release()
    await first.flush()
    clock.mockRestore()
    const rows = await database.select().from(commentsSchema.vitehubCommentForge)
    expect(github.comments.size).toBe(remove ? 0 : 2)
    expect(rows).toHaveLength(remove ? 0 : 2)
    expect(rows.every(row => github.comments.has(Number(row.remoteId)))).toBe(true)
    if (!remove) expect(rows.map(row => row.remoteId)).toEqual(before.map(row => row.remoteId))
  })

  it.each([
    { kind: "summary", remove: false },
    { kind: "comment", remove: false },
    { kind: "summary", remove: true },
    { kind: "comment", remove: true },
  ] as const)("retries failed cleanup of an expired $kind create (delete: $remove)", async ({ kind, remove }) => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const first = defineComments(options)
    const second = defineComments(options)
    installComments(first, { database })
    installComments(second, { database })
    const held = github.holdNextCreate(kind, false)
    const [, thread] = await first.create({ page: "/forecast", anchor, context: context(), body: "Late create.", author: ada })
    await held.started
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000)
    if (remove) {
      await second.remove(thread!.id)
      await second.flush()
    }
    else await second.sync(thread!.id)
    github.failNextRequests(1)
    held.release()
    await first.flush()
    clock.mockRestore()

    expect(github.comments.size).toBe(remove ? 1 : 3)
    const pending = await database.select().from(commentsSchema.vitehubCommentForge)
    expect([...github.comments.keys()].every(id => pending.some(row => row.remoteId === String(id)))).toBe(true)
    // A fresh isolate must find the cleanup even after the original thread and summary rows were deleted.
    const retry = defineComments(options)
    installComments(retry, { database })
    await retry.sync(thread!.id)
    expect(github.comments.size).toBe(remove ? 0 : 2)
    const rows = await database.select().from(commentsSchema.vitehubCommentForge)
    expect(rows).toHaveLength(remove ? 0 : 2)
    expect(rows.every(row => github.comments.has(Number(row.remoteId)))).toBe(true)
  })

  it.each(["summary", "comment"] as const)("keeps the latest edit when an older %s PATCH finishes last in another isolate", async (kind) => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const first = defineComments(options)
    const second = defineComments(options)
    installComments(first, { database })
    installComments(second, { database })
    const [, thread] = await first.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    await first.flush()
    const held = github.holdNextUpdate(kind)
    await first.edit(thread!.comments[0]!.id, { body: "Older edit." })
    await held.started
    await second.edit(thread!.comments[0]!.id, { body: "Newest edit." })
    await second.flush()
    held.release()
    await first.flush()
    expect(github.bodies().every(body => body.includes("Newest edit.") && !body.includes("Older edit."))).toBe(true)
    github.calls.length = 0
    await second.sync(thread!.id)
    expect(github.calls).toEqual([])
  })

  it("exposes a rejected PATCH and clears the failure after retry", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Initial.", author: ada })
    await comments.flush()
    github.failNextRequests(1)
    await comments.edit(thread!.comments[0]!.id, { body: "Edited." })
    await comments.flush()
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403"), url: expect.any(String) })
    await comments.sync(thread!.id)
    expect((await comments.get(thread!.id))[1]!.forge).toMatchObject({ state: "posted" })
    expect((await comments.get(thread!.id))[1]!.forge).not.toHaveProperty("error")
    expect(github.bodies().every(body => body.includes("Edited."))).toBe(true)
  })

  it("does not post threads before a failed initial summary is retried", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    github.failNextRequests(1)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Wait for summary.", author: ada })
    await comments.flush()
    expect(github.comments.size).toBe(0)
    await comments.sync(thread!.id)
    expect(github.bodies()).toHaveLength(2)
    expect(github.bodies()[0]).toContain("### Preview comments")
  })

  it("waits for another isolate's initial summary before posting its thread", async () => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const options = { forge: { provider: "github", fetch: github.fetch } } satisfies { forge: CommentsForgeOptions }
    const first = defineComments(options)
    const second = defineComments(options)
    installComments(first, { database })
    installComments(second, { database })
    const held = github.holdNextCreate("summary", false)
    await first.create({ page: "/forecast", anchor, context: context(), body: "First.", author: ada })
    await held.started
    const [, thread] = await second.create({ page: "/forecast", anchor, context: context(), body: "Second.", author: ada })
    // Explicit sync also waits behind the automatic sync of this thread.
    let finished = false
    const syncing = second.sync(thread!.id).then(() => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    const early = github.bodies()
    held.release()
    await Promise.all([first.flush(), second.flush(), syncing])
    expect(early).toEqual([])
    expect(finished).toBe(true)
    expect(github.bodies()).toHaveLength(3)
    expect(github.bodies()[0]).toContain("### Preview comments")
  })

  it("cleans threads inserted immediately before the scope deletion transaction", async () => {
    const github = fakeGitHub()
    const database = await createDatabase()
    const store = createCommentsStore(database)
    const comments = defineComments({ forge: { provider: "github", fetch: github.fetch } })
    installComments(comments, { database })
    await comments.create({ scope: "doc:1", page: "/forecast", context: context(), body: "Original.", author: ada })
    await comments.flush()
    const batch = database.batch.bind(database)
    const spy = vi.spyOn(database, "batch").mockImplementationOnce(async (queries) => {
      // The other writer commits before deletion takes SQLite's transaction lock.
      spy.mockRestore()
      const thread = await store.create({ scope: "doc:1", page: "/forecast", context: context(), body: "Concurrent.", author: ada, mentions: [] })
      github.comments.set(1000, { id: 1000, body: "Concurrent.", token: "app-token", minimized: false, pullRequest: 7 })
      await database.insert(commentsSchema.vitehubCommentForge).values({ id: thread.comments[0]!.id, threadId: thread.id, repository: "acme/app", pullRequest: 7, remoteId: "1000", updatedAt: Date.now() })
      return await batch(queries)
    })
    const [, result] = await comments.removeScope("doc:1")
    await comments.flush()
    expect(result).toEqual({ removed: 2 })
    expect(await database.select().from(commentsSchema.vitehubCommentForge)).toEqual([])
    expect(await database.select().from(commentsSchema.vitehubComments)).toEqual([])
    expect(github.comments.size).toBe(0)
  })

  it("finds marked comments beyond the first GitHub page", async () => {
    const github = fakeGitHub()
    for (let index = 0; index < 101; index++) {
      github.comments.set(index, { id: index, body: index === 100 ? "Recovered\n<!-- target -->" : "Unrelated", token: "app-token", minimized: false, pullRequest: 7 })
    }
    const client = createGitHubClient({ fetch: github.fetch })
    expect(await client.findComment("app-token", "acme/app", 7, "<!-- target -->")).toMatchObject({ id: "100", body: "Recovered\n<!-- target -->" })
  })

  it("uses the GitHub Enterprise GraphQL endpoint for resolve and reopen", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: {} }))
    const client = createGitHubClient({ apiUrl: "https://ghe.example.com/api/v3/", fetch })
    await client.minimize("app-token", "node-1", true)
    await client.minimize("app-token", "node-1", false)
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["https://ghe.example.com/api/graphql", "https://ghe.example.com/api/graphql"])
  })

  it("finds the pull request of the build's branch, and leaves threads without one alone", async () => {
    const github = fakeGitHub({ "feat/filters": 9 })
    const comments = await forgeComments(github)
    await comments.create({ page: "/forecast", anchor, context: context({ repository: "acme/app", branch: "feat/filters" }), body: "On nine.", author: ada })
    const [, alone] = await comments.create({ page: "/forecast", anchor, context: context({ repository: "acme/app", branch: "main" }), body: "No PR.", author: ada })
    const [, local] = await comments.create({ page: "/forecast", anchor, body: "No build.", author: ada })
    await comments.flush()

    expect(github.calls.filter(call => call.startsWith("POST /repos"))).toEqual(["POST /repos/acme/app/issues/9/comments", "POST /repos/acme/app/issues/9/comments"])
    const [, threads] = await comments.list()
    expect(threads!.filter(thread => thread.id === alone!.id || thread.id === local!.id).map(thread => thread.forge)).toEqual([null, null])
  })

  it("lets the app pick the repository and pull request", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github, { repository: "acme/app", pullRequest: thread => thread.page === "/forecast" ? 12 : undefined })
    await comments.create({ page: "/forecast", anchor, body: "Here.", author: ada })
    await comments.create({ page: "/alerts", anchor, body: "Not here.", author: ada })
    await comments.flush()
    expect(github.calls.filter(call => call.startsWith("POST /repos"))).toEqual(["POST /repos/acme/app/issues/12/comments", "POST /repos/acme/app/issues/12/comments"])
  })
})

describe("forge render", () => {
  const thread = {
    id: "t1",
    scope: "pages",
    number: 3,
    page: "/forecast",
    anchor,
    metadata: null,
    context: context(),
    status: "open",
    createdBy: ada,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    comments: [{ id: "c1", threadId: "t1", body: "Ask @grace | see #12", mentions: [], author: ada, createdAt: "2026-10-26T10:00:00.000Z", editedAt: null }],
  } satisfies CommentThread

  it("keeps app mentions and thread numbers from linking on GitHub", () => {
    expect(unlinked("@grace in #12, mail a@b.c")).toBe("@⁠grace in #⁠12, mail a@⁠b.c")
    expect(renderComment(thread, thread.comments[0], "author")).toContain("Ask @⁠grace \\| see \\#⁠12")
  })

  it.each(["app", "author"] as const)("keeps Markdown and HTML literal when posted as %s", (postedAs) => {
    const body = "[review](https://example.com) ![image](https://example.com/x.png)\n<b>bold</b> &lt;i&gt;\n**bold** _emphasis_ ~~strike~~ `code`\\\n# Heading\n- item\n1. ordered\n2) ordered"
    const literal = "\\[review\\](https\\://example.com) \\!\\[image\\](https\\://example.com/x.png)\n\\<b\\>bold\\</b\\> &amp;lt;i&amp;gt;\n\\*\\*bold\\*\\* \\_emphasis\\_ \\~\\~strike\\~\\~ \\`code\\`\\\\\n\\# Heading\n\\- item\n1\\. ordered\n2\\) ordered"
    const first = { ...thread.comments[0], body }
    const reply = { ...first, id: "c2" }
    const withReply = { ...thread, comments: [first, reply] }
    for (const comment of [first, reply]) {
      const rendered = renderComment(withReply, comment, postedAs)
      expect(rendered).toContain(postedAs === "app" ? literal.split("\n").map(line => `> ${line}`).join("\n") : literal)
    }
    const summary = renderSummary({ title: "Preview comments", threads: [{ thread: withReply, failed: false }] })
    expect(summary).toContain("\\[review\\](https\\://example.com) \\!\\[image\\](https\\://example.com/x.png)")
  })

  it.each(["app", "author"] as const)("renders URLs and indentation as plain text when posted as %s", (postedAs) => {
    const lines = ["[review](https://example.com)", "https://example.com", "http://example.com", "www.example.com", "    four leading spaces", "\tleading tab"]
    const first = { ...thread.comments[0], body: lines.join("\n\n") }
    const reply = { ...first, id: "c2" }
    const withReply = { ...thread, comments: [first, reply] }
    for (const comment of [first, reply]) {
      const document = new Window().document
      document.body.innerHTML = marked.parse(renderComment(withReply, comment, postedAs), { async: false, gfm: true })
      expect(document.querySelectorAll('a[href*="example.com"]')).toHaveLength(0)
      expect(document.querySelectorAll("pre")).toHaveLength(0)
      for (const line of lines) expect(document.body.textContent).toContain(line)
    }
  })

  it("keeps author display names from linking in threads, replies, and summaries", () => {
    const author = { id: "guest", name: "@owner #12", guest: true }
    const first = { ...thread.comments[0], author }
    const reply = { ...first, id: "c2" }
    const named = { ...thread, createdBy: author, comments: [first, reply] }
    expect(renderComment(named, first, "app")).toContain("**@⁠owner \\#⁠12 (guest)** commented")
    expect(renderComment(named, reply, "app")).toContain("**@⁠owner \\#⁠12 (guest)** replied")
    expect(renderSummary({ title: "Preview comments", threads: [{ thread: named, failed: false }] })).toContain("@⁠owner \\#⁠12 (guest)")
  })

  it("escapes table cells in the summary", () => {
    const summary = renderSummary({ title: "Preview comments", threads: [{ thread, failed: true }] })
    expect(summary).toContain("| [#⁠3](https://pr7.preview.acme.dev/forecast?group=eu&comments#comment-t1) | Ask @⁠grace \\| see \\#⁠12<br><sub>`/forecast` · Ada</sub> | Open, not posted yet |")
  })
})
