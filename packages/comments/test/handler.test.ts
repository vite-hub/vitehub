import { ViteHubError } from "@vite-hub/runtime"
import { H3 } from "h3"
import { describe, expect, it, vi } from "vitest"

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

async function setup(input: { user?: CommentsUser | null, options?: DefineCommentsOptions, content?: ReturnType<typeof fakeContent>, session?: CommentsHandlerOptions["session"], consoleSession?: CommentsHandlerOptions["consoleSession"] } = {}) {
  const comments = await createComments({ identify: () => input.user === undefined ? { id: "ada", name: "Ada" } : input.user, ...input.options })
  const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({
    comments,
    session: input.session,
    consoleSession: input.consoleSession,
    content: input.content ? { runtime: input.content.runtime, parseField } : undefined,
    realtime: true,
    build: { commit: "abc123", branch: "main" },
    components: { PricingCard: ["app/components/PricingCard.vue"], index: ["app/pages/index.vue", "app/pages/blog/index.vue"] },
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
  it.each([{ id: "custom", name: "Custom" }, null])("skips the Auth session when custom identify returns %j", async (user) => {
    const session = vi.fn(async () => { throw new Error("Auth unavailable") })
    const identify = vi.fn(() => user)
    const { call } = await setup({ session, options: { identify, authorize: () => true } })
    const current = await call("/session")
    expect(current.body.data).toMatchObject({ user, can: { read: true, comment: true, resolve: true } })
    expect((await call("/threads?page=/")).response.status).toBe(200)
    expect(identify).toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
  })

  it.each(["authorize", "user", "identify"] as const)("denies Console session failures in %s before Comments identity or policy", async (source) => {
    for (const customIdentity of [false, true]) {
      const identify = vi.fn(() => ({ id: "custom", name: "Custom" }))
      const authorize = vi.fn(() => true)
      const fail = async () => { throw new Error("Console session unavailable") }
      const session = commentsConsoleSession({
        authorize: source === "authorize" ? fail : async () => true,
        user: source === "user" ? fail : async () => null,
        identify: source === "identify" ? fail : async () => null,
      })
      const { call } = await setup({ consoleSession: session, options: { identify: customIdentity ? identify : undefined, authorize } })
      const current = await call("/session")
      expect(current.body.data).toMatchObject({ user: null, can: { read: false, comment: false, resolve: false } })
      expect(current.response.headers.get("set-cookie")).toContain("Max-Age=0")
      expect((await call("/threads?page=/")).response.status).toBe(403)
      expect((await call("/threads", {
        method: "POST",
        json: { page: "/", anchor, body: "Denied" },
        headers: { "x-vitehub-comments-guest-id": "visitor", "x-vitehub-comments-guest-name": "Visitor" },
      })).response.status).toBe(403)
      expect(identify).not.toHaveBeenCalled()
      expect(authorize).not.toHaveBeenCalled()
    }
  })

  it("keeps Console guest authors anonymous to Comments policies", async () => {
    const session = commentsConsoleSession({ authorize: async () => true, user: async () => null, identify: async () => null })
    const { call } = await setup({ consoleSession: session, options: { identify: undefined, authorize: ({ user }) => user === null } })
    const headers = { "x-vitehub-comments-guest-id": "visitor", "x-vitehub-comments-guest-name": "Visitor" }
    const current = await call("/session", { headers })
    expect(current.body.data).toMatchObject({ user: null, can: { read: true, comment: true, resolve: true } })
    const created = await call("/threads", { headers, method: "POST", json: { page: "/", anchor, body: "Hi" } })
    expect(created.response.status).toBe(200)
    expect(created.body.data.createdBy).toEqual({ id: "guest:visitor", name: "Visitor", guest: true })
    expect(created.body.data.can).toEqual({ comment: true, resolve: true })
  })

  it.each([false, true])("requires Content to allow anonymous writes for Console guests: %s", async (allowAnonymous) => {
    const session = commentsConsoleSession({ authorize: async () => true, user: async () => null, identify: async () => null })
    const content = fakeContent()
    const canWrite = vi.fn(async ({ user }: Parameters<CommentsContent["can"]>[0]) => user != null || allowAnonymous)
    content.runtime.can = canWrite
    const { call } = await setup({ consoleSession: session, content, options: { identify: undefined, authorize: () => true } })
    const headers = { "x-vitehub-comments-guest-id": "visitor", "x-vitehub-comments-guest-name": "Visitor" }
    const saved = await call("/fields", { headers, method: "POST", json: { field: "about#hero.title", value: "Guest edit", ifDigest: "d1" } })
    expect(saved.response.status).toBe(allowAnonymous ? 200 : 403)
    if (!allowAnonymous) expect(saved.body.error?.code).toBe("COMMENTS_FIELD_FORBIDDEN")
    expect(canWrite).toHaveBeenCalledWith(expect.objectContaining({ user: undefined }))
    expect(content.saves).toHaveLength(allowAnonymous ? 1 : 0)
  })

  it.each([undefined, () => ({ id: "custom", name: "Custom" })])("preserves Console denial before guest policies or custom identity: %s", async (identify) => {
    const session = commentsConsoleSession({ authorize: async () => false, user: async () => null, identify: async () => null })
    const { comments, call } = await setup({ consoleSession: session, options: { identify, authorize: () => true } })
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

  it.each(["https://other.test/pricing", "http://site.test/other", "/pricing", "not a URL"])("rejects a context URL outside the request origin and thread page: %s", async (url) => {
    const { call } = await setup()
    const { response, body } = await call("/threads", { method: "POST", json: { page: "/pricing", anchor, context: { url }, body: "Hi" } })
    expect(response.status).toBe(400)
    expect(body.error?.code).toBe("COMMENTS_INVALID_INPUT")
    expect((await call("/threads?page=/pricing")).body.data).toEqual([])
  })

  it("uses the forwarded origin and normalized thread page for context URLs", async () => {
    const { call } = await setup()
    const { response, body } = await call("/threads", {
      method: "POST",
      headers: { origin: "https://public.test", "x-forwarded-host": "public.test", "x-forwarded-proto": "https" },
      json: { page: "/pricing/?comments", anchor, context: { url: "https://public.test/pricing/?token=secret#token" }, body: "Hi" },
    })
    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({ page: "/pricing", context: { url: "https://public.test/pricing" } })
  })

  it("keeps the page context, and adds the build and the component files that only the server knows", async () => {
    const { call } = await setup()
    const context = {
      url: "http://site.test/pricing?code=oauth-code&token=reset-token&X-Amz-Signature=secret#token",
      title: "Pricing",
      route: "/pricing",
      element: { tag: "button", role: "button", name: "Buy" },
      components: [{ name: "index", files: ["/etc/passwd"] }, { name: "PricingCard" }, { name: "Unknown" }],
      environment: { viewport: { width: 1280, height: 800 }, devicePixelRatio: 2, userAgent: "Test", colorScheme: "dark" },
      build: { commit: "forged" },
    }
    const created = await call("/threads", { method: "POST", json: { page: "/pricing", anchor, context, body: "Buy is hidden" } })
    expect(created.body.data.can).toEqual({ comment: true, resolve: true })
    expect(created.body.data.context).toEqual({
      ...context,
      url: "http://site.test/pricing",
      components: [
        { name: "index", files: ["app/pages/index.vue", "app/pages/blog/index.vue"] },
        { name: "PricingCard", files: ["app/components/PricingCard.vue"] },
      ],
      build: { commit: "abc123", branch: "main" },
    })
    const library = await call("/threads", { method: "POST", json: { page: "/pricing", anchor, context: { url: "http://site.test/pricing", components: ["A", "B", "C", "D"].map(name => ({ name })) }, body: "Hi" } })
    expect(library.body.data.context.components).toEqual([{ name: "B" }, { name: "C" }, { name: "D" }])
    const invalid = await call("/threads", { method: "POST", json: { page: "/pricing", anchor, context: { url: "x".repeat(3000) }, body: "Hi" } })
    expect(invalid.body.error?.code).toBe("COMMENTS_INVALID_INPUT")
  })

  it("treats inherited component-map keys as unknown names", async () => {
    const { call } = await setup()
    const components = ["constructor", "toString", "__proto__"].map(name => ({ name }))
    const { response, body } = await call("/threads", {
      method: "POST",
      json: { page: "/pricing", anchor, context: { url: "http://site.test/pricing", components }, body: "Hi" },
    })
    expect(response.status).toBe(200)
    expect(body.data.context.components).toEqual(components)
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
    const { comments, call } = await setup({ consoleSession: session, options: { identify: undefined, authorize: () => true } })
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
