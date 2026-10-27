import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { createGitHubClient } from "../src/forge/github.ts"
import { renderComment, renderSummary, unlinked } from "../src/forge/render.ts"
import { forgetGitHubToken, rememberGitHubToken } from "../src/forge/tokens.ts"
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
  let lostResponse: "summary" | "comment" | undefined
  let heldCreate: { kind: "summary" | "comment", started: () => void, released: Promise<void> } | undefined
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? ""
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${method} ${url.pathname}`)
    const json = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
    if (failNext > 0) {
      failNext--
      return json({ message: "Resource not accessible by integration" }, 403)
    }
    if (url.pathname === "/graphql") {
      const { query, variables } = body as { query: string, variables: { id: string } }
      const comment = comments.get(Number(variables.id.replace("node-", "")))
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
      comments.set(id, { id, body: text, token, minimized: false, pullRequest: Number(match[1]) })
      if (heldCreate?.kind === kind) {
        const held = heldCreate
        heldCreate = undefined
        held.started()
        await held.released
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
      if (method === "PATCH") comment.body = (body as { body: string }).body
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
    loseNextCreateResponse(kind: "summary" | "comment") {
      lostResponse = kind
    },
    holdNextCreate(kind: "summary" | "comment") {
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { start = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      heldCreate = { kind, started: start, released }
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
    forgetGitHubToken("ada")
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

  it("posts as a person who signed in with GitHub, with the token of their last request", async () => {
    const github = fakeGitHub()
    const comments = await forgeComments(github)
    rememberGitHubToken("ada", "ada-signed-in")
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.reply(thread!.id, { body: "Agreed.", author: grace })
    await comments.flush()
    forgetGitHubToken("ada")
    const [, first, reply] = [...github.comments.values()]
    expect(first).toMatchObject({ token: "ada-signed-in" })
    expect(reply).toMatchObject({ token: "app-token" })
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
    github.failNextRequests(2)
    const [, thread] = await comments.create({ page: "/forecast", anchor, context: context(), body: "Cut off.", author: ada })
    await comments.flush()

    const [, failed] = await comments.get(thread!.id)
    expect(failed!.forge).toMatchObject({ state: "failed", error: expect.stringContaining("403") })

    await comments.sync(thread!.id)
    const [, posted] = await comments.get(thread!.id)
    expect(posted!.forge).toMatchObject({ state: "posted" })
    expect(github.bodies().some(body => body.includes("> Cut off."))).toBe(true)
  })

  it.each([
    { kind: "summary", signedIn: false },
    { kind: "comment", signedIn: false },
    { kind: "summary", signedIn: true },
    { kind: "comment", signedIn: true },
  ] as const)("adopts a $kind whose create response was lost with signed-in token $signedIn", async ({ kind, signedIn }) => {
    const github = fakeGitHub()
    if (signedIn) rememberGitHubToken("ada", "ada-token")
    const comments = await forgeComments(github, signedIn ? {} : { token: () => "ada-token" })
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
    expect(renderComment(thread, thread.comments[0], "author")).toContain("Ask @⁠grace | see #⁠12")
  })

  it("keeps author display names from linking in threads, replies, and summaries", () => {
    const author = { id: "guest", name: "@owner #12", guest: true }
    const first = { ...thread.comments[0], author }
    const reply = { ...first, id: "c2" }
    const named = { ...thread, createdBy: author, comments: [first, reply] }
    expect(renderComment(named, first, "app")).toContain("**@⁠owner #⁠12 (guest)** commented")
    expect(renderComment(named, reply, "app")).toContain("**@⁠owner #⁠12 (guest)** replied")
    expect(renderSummary({ title: "Preview comments", threads: [{ thread: named, failed: false }] })).toContain("@⁠owner #⁠12 (guest)")
  })

  it("escapes table cells in the summary", () => {
    const summary = renderSummary({ title: "Preview comments", threads: [{ thread, failed: true }] })
    expect(summary).toContain("| [#⁠3](https://pr7.preview.acme.dev/forecast?group=eu&comments#comment-t1) | Ask @⁠grace \\| see #⁠12<br><sub>`/forecast` · Ada</sub> | Open, not posted yet |")
  })
})
