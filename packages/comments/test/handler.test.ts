import { ViteHubError } from "@vite-hub/runtime"
import { H3 } from "h3"
import { describe, expect, it } from "vitest"

import { createCommentsHandler } from "../src/runtime/handler.ts"
import { commentsConsoleSession } from "../src/runtime/console-session.ts"
import { anchor, createComments } from "./harness.ts"

import type { CommentsContent, CommentsHandlerOptions } from "../src/runtime/handler.ts"
import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"

const origin = "http://site.test"

function parseField(value: string) {
  const [head, field] = value.split("#")
  if (!head || !field) return
  const [collection, id] = head.split(":")
  return id ? { collection: collection!, id, field } : { collection: collection!, field }
}

function fakeContent(options: { can?: boolean, fail?: Error } = {}) {
  const documents = new Map<string, { data: Record<string, unknown>, body?: string, digest: string }>([
    ["about", { data: { hero: { title: "About us", stats: [1, 2] } }, digest: "d1" }],
  ])
  const saves: Array<{ id: string, data: Record<string, unknown>, ifDigest: string }> = []
  const collection = {
    name: "about",
    kind: "singleton" as const,
    id: "about",
    format: "yaml",
    get: async (id: string) => {
      const document = documents.get(id)
      return document ? { id, ...document } : null
    },
    save: async (id: string, input: { data: Record<string, unknown> }, write: { ifDigest: string }) => {
      if (options.fail) throw options.fail
      saves.push({ id, data: input.data, ifDigest: write.ifDigest })
      const saved = { data: input.data, digest: `d${saves.length + 1}` }
      documents.set(id, saved)
      return { id, ...saved }
    },
  }
  const runtime: CommentsContent = {
    can: async () => options.can ?? true,
    collections: () => [collection],
  }
  return { runtime, saves }
}

async function setup(input: { user?: CommentsUser | null, options?: DefineCommentsOptions, content?: ReturnType<typeof fakeContent>, session?: CommentsHandlerOptions["session"] } = {}) {
  const comments = await createComments({ identify: () => input.user === undefined ? { id: "ada", name: "Ada" } : input.user, ...input.options })
  const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({
    comments,
    session: input.session,
    content: input.content ? { runtime: input.content.runtime, parseField } : undefined,
    realtime: true,
  }))
  const call = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set("content-type", "application/json")
    if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", origin)
    const response = await app.fetch(new Request(`${origin}/api/_vitehub/comments${path}`, { ...init, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) }))
    return { response, body: await response.json() as { data?: any, error?: { code: string, why: string } } }
  }
  return { comments, call }
}

describe("Comments API", () => {
  it.each([undefined, () => ({ id: "custom", name: "Custom" })])("preserves Console denial before guest policies or custom identity: %s", async (identify) => {
    const session = commentsConsoleSession({ authorize: async () => false, user: async () => null, identify: async () => null })
    const { comments, call } = await setup({ session, options: { identify, authorize: () => true } })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Private", author: { id: "ada", name: "Ada" } })
    const current = await call("/session")
    expect(current.body.data.can).toEqual({ read: false, comment: false, resolve: false })
    expect(current.response.headers.get("set-cookie")).toContain("Max-Age=0")
    for (const [path, init] of [
      ["/threads?page=/", {}],
      ["/threads", { method: "POST", json: { page: "/", anchor, body: "Denied" } }],
      [`/threads/${thread!.id}/comments`, { method: "POST", json: { body: "Denied" } }],
    ] as const) {
      const denied = await call(path, { ...init, headers: { "x-vitehub-comments-guest-id": "visitor", "x-vitehub-comments-guest-name": "Visitor" } })
      expect(denied.response.status).toBe(403)
    }
  })

  it("answers the session with access, and sets the comment mode hint", async () => {
    const { call } = await setup()
    const { response, body } = await call("/session")
    expect(body.data).toEqual({ user: { id: "ada", name: "Ada" }, can: { read: true, comment: true, resolve: true }, realtime: true, content: false })
    expect(response.headers.get("set-cookie")).toContain("vitehub-comments=1")
  })

  it("clears the hint and denies threads to an anonymous user by default", async () => {
    const { call } = await setup({ user: null })
    const session = await call("/session")
    expect(session.body.data.can.read).toBe(false)
    expect(session.response.headers.get("set-cookie")).toContain("Max-Age=0")
    const threads = await call("/threads?page=/")
    expect(threads.response.status).toBe(403)
    expect(threads.body.error?.code).toBe("COMMENTS_FORBIDDEN")
  })

  it("reports per-thread permissions separately from new-thread permissions", async () => {
    const { comments, call } = await setup({ options: {
      authorize: ({ user, action, thread }) => action === "read" || thread?.createdBy.id === user?.id,
    } })
    const [, own] = await comments.create({ page: "/", anchor, body: "Mine", author: { id: "ada", name: "Ada" } })
    await comments.create({ page: "/", anchor, body: "Theirs", author: { id: "lin", name: "Lin" } })
    expect((await call("/session")).body.data.can).toEqual({ read: true, comment: false, resolve: false })
    const listed = (await call("/threads?page=/")).body.data
    expect(listed.find((item: { id: string }) => item.id === own!.id).can).toEqual({ comment: true, resolve: true })
    expect(listed.find((item: { id: string }) => item.id !== own!.id).can).toEqual({ comment: false, resolve: false })
    const resolved = await call(`/threads/${own!.id}/resolve`, { method: "POST" })
    expect(resolved.body.data.can).toEqual({ comment: true, resolve: true })
  })

  it("creates, lists, replies, resolves, and deletes through HTTP", async () => {
    const { call } = await setup()
    const created = await call("/threads", { method: "POST", json: { page: "/pricing", anchor, body: "Looks off" } })
    expect(created.body.data).toMatchObject({ page: "/pricing", createdBy: { id: "ada" } })
    const id = created.body.data.id
    const reply = await call(`/threads/${id}/comments`, { method: "POST", json: { body: "Agreed" } })
    expect(reply.body.data.body).toBe("Agreed")
    expect((await call("/threads?page=/pricing")).body.data).toHaveLength(1)
    expect((await call(`/threads/${id}/resolve`, { method: "POST" })).body.data.status).toBe("resolved")
    expect((await call(`/threads/${id}/comments/${reply.body.data.id}`, { method: "DELETE" })).response.status).toBe(200)
    expect((await call(`/threads/${id}`, { method: "DELETE" })).response.status).toBe(200)
    expect((await call("/threads?page=/pricing")).body.data).toEqual([])
  })

  it("rejects writes from another origin, and accepts the origin behind a TLS proxy", async () => {
    const { call } = await setup()
    const foreign = await call("/threads", { method: "POST", json: { page: "/", anchor, body: "Hi" }, headers: { origin: "https://evil.test" } })
    expect(foreign.response.status).toBe(403)
    const proxied = await call("/threads", { method: "POST", json: { page: "/", anchor, body: "Hi" }, headers: { "origin": "https://site.test", "x-forwarded-proto": "https", "x-forwarded-host": "site.test" } })
    expect(proxied.response.status).toBe(200)
  })

  it("lets guests comment under a name only when authorize allows anonymous users", async () => {
    const { call } = await setup({ user: null, options: { authorize: () => true } })
    const guest = { "x-vitehub-comments-guest-id": "g1", "x-vitehub-comments-guest-name": encodeURIComponent("Lin") }
    const created = await call("/threads", { method: "POST", json: { page: "/", anchor, body: "Hi" }, headers: guest })
    expect(created.body.data.createdBy).toEqual({ id: "guest:g1", name: "Lin", guest: true })
    const nameless = await call("/threads", { method: "POST", json: { page: "/", anchor, body: "Hi" } })
    expect(nameless.body.error?.code).toBe("COMMENTS_FORBIDDEN")
  })

  it.each([false, true])("rejects guest deletion even when a visible author ID is copied, with Console: %s", async (console) => {
    const session = console ? commentsConsoleSession({ authorize: async () => true, user: async () => null, identify: async () => null }) : undefined
    const { comments, call } = await setup({ session, options: { identify: undefined, authorize: () => true } })
    const headers = { "x-vitehub-comments-guest-id": "victim", "x-vitehub-comments-guest-name": "Visitor" }
    const created = await call("/threads", { method: "POST", headers, json: { page: "/", anchor, body: "Root" } })
    const id = created.body.data.id
    const reply = await call(`/threads/${id}/comments`, { method: "POST", headers, json: { body: "Reply" } })
    const exposed = (await call("/threads?page=/")).body.data[0].createdBy.id
    const copied = { ...headers, "x-vitehub-comments-guest-id": exposed.slice("guest:".length) }
    for (const path of [`/threads/${id}/comments/${reply.body.data.id}`, `/threads/${id}/comments/${created.body.data.comments[0].id}`, `/threads/${id}`]) {
      expect((await call(path, { method: "DELETE", headers: copied })).response.status).toBe(403)
    }
    const [error, saved] = await comments.get(id)
    expect(error).toBeUndefined()
    expect(saved?.comments.map(comment => comment.body)).toEqual(["Root", "Reply"])
  })

  it("lets a resolve-only moderator delete comments and threads", async () => {
    const { comments, call } = await setup({ user: { id: "moderator", name: "Moderator" }, options: { authorize: ({ action }) => action !== "comment" } })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Root", author: { id: "writer", name: "Writer" } })
    const [, reply] = await comments.reply(thread!.id, { body: "Reply", author: { id: "writer", name: "Writer" } })
    expect((await call(`/threads/${thread!.id}/comments/${reply!.id}`, { method: "DELETE" })).response.status).toBe(200)
    expect((await call(`/threads/${thread!.id}`, { method: "DELETE" })).response.status).toBe(200)
  })

  it("lets authors delete their own reply, and only resolvers delete others'", async () => {
    let user: CommentsUser = { id: "ada", name: "Ada", role: "editor" }
    const comments = await createComments({ identify: () => user, authorize: ({ user, action }) => action !== "resolve" || user?.role === "editor" })
    const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
    const [, thread] = await comments.create({ page: "/", anchor, body: "Root", author: { id: "ada", name: "Ada" } })
    const [, mine] = await comments.reply(thread!.id, { body: "Mine", author: { id: "writer", name: "W" } })
    const [, theirs] = await comments.reply(thread!.id, { body: "Theirs", author: { id: "ada", name: "Ada" } })
    user = { id: "writer", name: "W", role: "writer" }
    const remove = (comment: string) => app.fetch(new Request(`${origin}/api/_vitehub/comments/threads/${thread!.id}/comments/${comment}`, { method: "DELETE", headers: { origin } }))
    expect((await remove(theirs!.id)).status).toBe(403)
    expect((await remove(mine!.id)).status).toBe(200)
  })

  it("reads a Content field draft and saves an edit with ifDigest", async () => {
    const content = fakeContent()
    const { call } = await setup({ content })
    const field = await call(`/fields?field=${encodeURIComponent("about#hero.title")}`)
    expect(field.body.data).toEqual({ field: "about#hero.title", value: "About us", editable: true, digest: "d1", collection: "about", id: "about" })
    const saved = await call("/fields", { method: "POST", json: { field: "about#hero.title", value: "About Quiver", ifDigest: "d1" } })
    expect(saved.body.data).toEqual({ field: "about#hero.title", value: "About Quiver", digest: "d2" })
    expect(content.saves).toEqual([{ id: "about", data: { hero: { title: "About Quiver", stats: [1, 2] } }, ifDigest: "d1" }])
    const stale = await call("/fields", { method: "POST", json: { field: "about#hero.title", value: "Again", ifDigest: "d1" } })
    expect(stale.body.error?.code).toBe("COMMENTS_FIELD_CONFLICT")
  })

  it("refuses fields that are not text, unknown, or forbidden", async () => {
    const { call } = await setup({ content: fakeContent() })
    expect((await call(`/fields?field=${encodeURIComponent("about#hero.stats")}`)).body.data).toMatchObject({ editable: false, value: null })
    const notText = await call("/fields", { method: "POST", json: { field: "about#hero.stats", value: "x", ifDigest: "d1" } })
    expect(notText.body.error?.code).toBe("COMMENTS_FIELD_NOT_EDITABLE")
    expect((await call(`/fields?field=${encodeURIComponent("posts:a#title")}`)).body.error?.code).toBe("COMMENTS_FIELD_INVALID")
    const denied = await setup({ content: fakeContent({ can: false }) })
    expect((await denied.call(`/fields?field=${encodeURIComponent("about#hero.title")}`)).response.status).toBe(403)
    expect((await (await setup()).call(`/fields?field=x`)).body.error?.code).toBe("COMMENTS_CONTENT_MISSING")
  })

  it("names the holder when a Console edit lease blocks the save", async () => {
    const lease = new ViteHubError("CONTENT_LEASE_HELD", "held", { details: { holder: { user: { id: "g", name: "Grace" } } } })
    const { call } = await setup({ content: fakeContent({ fail: lease }) })
    const locked = await call("/fields", { method: "POST", json: { field: "about#hero.title", value: "New", ifDigest: "d1" } })
    expect(locked.response.status).toBe(423)
    expect(locked.body.error?.why).toContain("Grace")
  })
})
