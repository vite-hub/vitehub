import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { createServer, request as httpRequest } from "node:http"
import { Readable } from "node:stream"
import type { AddressInfo } from "node:net"
import { H3, redirect } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineCollectionHandler } from "@vite-hub/source/server"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { shouldBypassCache } from "@vite-hub/internal/runtime/cache-bypass"

import { documents } from "../src/collections.ts"
import { contentPreviewErrorName } from "../src/client.ts"
import { contentPreviewCookieName, contentPreviewFrameParameter, contentPreviewPublishedParameter, defineContent, defineContentHandler, defineContentPreviewPlugin } from "../src/index.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0
const key = Buffer.alloc(32, 7).toString("base64")

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-preview-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `preview-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

/** One published post whose draft has a different title, plus a draft-only post. */
async function setup() {
  vi.stubEnv("VITEHUB_CONTENT_KEY", key)
  const workspace = await historyWorkspace()
  const content = defineContent({
    workspace,
    collections: { posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }) },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  const posts = content.collection("posts")
  await posts.save("hello", { data: { title: "Published" }, body: "# Hello" })
  await content.publish()
  await posts.save("hello", { data: { title: "Draft" }, body: "# Hello" })
  await posts.save("new", { data: { title: "New" }, body: "# New" })
  return { content, posts }
}

/** Enable preview on a throwaway request and return the Cookie header a browser would send. */
async function previewCookie(content: Pick<Awaited<ReturnType<typeof setup>>["content"], "preview">, options?: { maxAge?: number }) {
  const { setCookie } = await content.preview.enable(new Request("https://site.test/_vitehub"), options)
  return setCookie.split(";", 1)[0]!
}

function tokenOf(cookie: string): string {
  return cookie.slice(contentPreviewCookieName.length + 1)
}

/** The frontmatter title of a `/api/content/get` response. */
async function titleOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json()
  return Reflect.get(Object(Reflect.get(Object(body), "data")), "title")
}

interface ServerResponseLike {
  body?: unknown
  headers: Record<string, string>
  headersSent: boolean
  setHeader(name: string, value: string): void
}

function serverResponse(): ServerResponseLike {
  return {
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
  }
}

function contentApp(content: Awaited<ReturnType<typeof setup>>["content"]) {
  return new H3().all("/api/content/**", defineContentHandler(content))
}

interface NodePage {
  status?: number
  headers?: Record<string, string | string[]>
  body?: string | ReadableStream<Uint8Array>
}

interface NodeRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

/**
 * A Nitro 2 app on a real Node server: an h3 v1 app handler that `render` answers through the Node response, and the
 * `localCall()` that runs that handler in process with a recorded response, the way Nitro 2 does.
 */
async function nitro2Server(render: (request: NodeRequestLike) => NodePage | Promise<NodePage>) {
  interface NodeResponseLike { statusCode: number, socket?: unknown, _data?: unknown, setHeader(name: string, value: string | string[]): void, end(body?: string): void }
  const nitroApp = {
    h3App: {
      async handler(event: { node: { req: NodeRequestLike, res: NodeResponseLike } }) {
        const page = await render(event.node.req)
        event.node.res.statusCode = page.status ?? 200
        for (const [name, value] of Object.entries(page.headers ?? {})) event.node.res.setHeader(name, value)
        if (typeof page.body === "string" || page.body === undefined) {
          event.node.res.end(page.body ?? "")
          return
        }
        // h3 v1 sendStream(): without a socket, as in localCall(), the stream stays as the body of the response.
        if (!event.node.res.socket) {
          event.node.res._data = page.body
          return
        }
        for await (const chunk of page.body) Reflect.apply(Reflect.get(event.node.res, "write") as (chunk: Uint8Array) => void, event.node.res, [chunk])
        event.node.res.end()
      },
    },
    hooks: { hook: () => undefined },
    calls: [] as Array<{ url: string, method: string, headers: Record<string, unknown>, protocol: string }>,
    async localCall(request: { url: string, method: string, headers: Record<string, string>, protocol: string }) {
      nitroApp.calls.push(request)
      const recorded = { statusCode: 200, statusMessage: "", headers: {} as Record<string, string | string[]>, body: "" as unknown }
      const res = {
        get statusCode() { return recorded.statusCode },
        set statusCode(value: number) { recorded.statusCode = value },
        set _data(value: unknown) { recorded.body = value },
        setHeader: (name: string, value: string | string[]) => { recorded.headers[name.toLowerCase()] = value },
        end: (body?: string) => { recorded.body = body ?? "" },
      }
      // SAFETY: The plugin replaced the handler with one that takes an h3 v1 event.
      await (nitroApp.h3App.handler as (event: unknown) => Promise<unknown>)({ node: { req: { ...request, socket: { encrypted: request.protocol === "https" } }, res } })
      return { status: recorded.statusCode, statusText: recorded.statusMessage, headers: recorded.headers, body: recorded.body }
    },
  }
  return nitroApp
}

/** Serves a Nitro 2 app on 127.0.0.1 and returns its base URL. */
async function listen(nitroApp: { h3App: { handler: unknown } }): Promise<string> {
  // SAFETY: The plugin replaced the handler with one that takes an h3 v1 event.
  const server = createServer((req, res) => void (nitroApp.h3App.handler as (event: unknown) => Promise<unknown>)({ node: { req, res } }))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** The form a preview frame posts, for `token`, with `title` on screen for posts/hello. */
function frameForm(token: string, title = "On screen"): string {
  return new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token, document: { collection: "posts", id: "hello", data: { title } } }) }).toString()
}

describe("content preview", { timeout: 30_000 }, () => {
  it("serves drafts from /api/content only with a valid preview cookie, privately", async () => {
    const { content } = await setup()
    const app = contentApp(content)
    const cookie = await previewCookie(content)

    const publicResponse = await app.request("/api/content/get/posts/hello")
    expect(await publicResponse.json()).toMatchObject({ data: { title: "Published" } })
    expect(publicResponse.headers.get("cache-control")).toBeNull()

    const previewResponse = await app.request("/api/content/get/posts/hello", { headers: { cookie: `theme=dark; ${cookie}` } })
    expect(await previewResponse.json()).toMatchObject({ data: { title: "Draft" } })
    expect(previewResponse.headers.get("cache-control")).toBe("private, no-store")
    expect(previewResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow")

    expect(await (await app.request("/api/content/get/posts/new", { headers: { cookie } })).json()).toMatchObject({ data: { title: "New" } })
    expect(await (await app.request("/api/content/get/posts/new")).json()).toBeNull()
  })

  it("ignores tampered, expired, and foreign tokens", async () => {
    const { content } = await setup()
    const app = contentApp(content)
    const read = async (cookie: string) => await titleOf(await app.request("/api/content/get/posts/hello", { headers: { cookie } }))
    const cookie = await previewCookie(content, { maxAge: 60 })
    const [version, expires, signature] = tokenOf(cookie).split(".") as [string, string, string]
    const flipped = `${signature.slice(0, -2)}${signature.at(-2) === "A" ? "B" : "A"}${signature.at(-1)}`

    expect(await read(cookie)).toBe("Draft")
    expect(await read(`${contentPreviewCookieName}=${version}.${expires}.${flipped}`)).toBe("Published")
    expect(await read(`${contentPreviewCookieName}=${version}.${Number(expires) + 3600}.${signature}`)).toBe("Published")
    expect(await read(`${contentPreviewCookieName}=v2.${expires}.${signature}`)).toBe("Published")
    expect(await read(`${contentPreviewCookieName}=garbage`)).toBe("Published")

    vi.stubEnv("VITEHUB_CONTENT_KEY", Buffer.alloc(32, 9).toString("hex"))
    expect(await read(cookie)).toBe("Published")
    vi.stubEnv("VITEHUB_CONTENT_KEY", key)
    expect(await read(cookie)).toBe("Draft")

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] })
    expect(await read(cookie)).toBe("Published")
  })

  it("routes every server read to the draft inside a preview request and nowhere else", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const request = new Request("https://site.test/blog", { headers: { cookie } })

    const reads = async () => ({
      active: content.preview.active(),
      get: (await content.get("/posts/hello"))?.data.title,
      list: (await content.list("posts")).map(item => item.path).sort(),
      navigation: JSON.stringify(await content.navigation(["posts"])).includes("/posts/new"),
      document: (await posts.get("hello"))?.data.title,
      pinned: (await posts.get("hello", { ref: "published" }))?.data.title,
      listed: (await posts.list()).items.map(item => item.data.title),
      page: (await posts.page({ query: {} })).items.map(item => item.id),
    })

    expect(await content.preview.run(request, reads)).toEqual({
      active: true,
      get: "Draft",
      list: ["/posts/hello", "/posts/new"],
      navigation: true,
      document: "Draft",
      pinned: "Published",
      listed: ["Draft", "New"],
      page: ["hello", "new"],
    })
    expect(await reads()).toEqual({
      active: false,
      get: "Published",
      list: ["/posts/hello"],
      navigation: false,
      document: "Published",
      pinned: "Published",
      listed: ["Published"],
      page: ["hello"],
    })
  })

  it("keeps concurrent preview and public requests isolated", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const results = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const preview = index % 2 === 0
      const request = new Request("https://site.test/", { headers: preview ? { cookie } : {} })
      return await content.preview.run(request, async () => {
        await new Promise(resolve => setTimeout(resolve, (index * 7) % 5))
        const document = await content.get("/posts/hello")
        const listed = await posts.list()
        return { preview, title: document?.data.title, total: listed.total }
      })
    }))
    for (const result of results) {
      expect(result).toEqual(result.preview ? { preview: true, title: "Draft", total: 2 } : { preview: false, title: "Published", total: 1 })
    }
  })

  it("refreshes the draft between preview requests after a save", async () => {
    const { content, posts } = await setup()
    const app = contentApp(content)
    const cookie = await previewCookie(content)
    const read = async () => await titleOf(await app.request("/api/content/get/posts/hello", { headers: { cookie } }))
    expect(await read()).toBe("Draft")
    await posts.save("hello", { data: { title: "Edited" }, body: "# Hello" })
    expect(await read()).toBe("Edited")
    expect(await (await app.request("/api/content/get/posts/hello")).json()).toMatchObject({ data: { title: "Published" } })
  })

  it("scopes whole Nitro 3 requests through the generated plugin and bypasses Nitro's cache", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const run = vi.spyOn(content.preview, "run")
    const app = new H3()
      .get("/blog/hello", async event => {
        // Route rule headers, such as an swr rule's, must not make a draft response public.
        event.res.headers.set("cache-control", "s-maxage=60")
        return { bypass: shouldBypassCache(), title: (await posts.get("hello"))?.data.title }
      })
      .get("/posts", defineCollectionHandler(posts))
      .all("/api/content/**", defineContentHandler(content))
    // The shape of a Nitro 3 app: plugins may replace the fetch entry before presets read it.
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)

    const page = await nitroApp.fetch(new Request("https://site.test/blog/hello"))
    expect(await page.json()).toEqual({ bypass: false, title: "Published" })
    expect(page.headers.get("cache-control")).toBe("s-maxage=60")
    expect(run).not.toHaveBeenCalled()

    const preview = await nitroApp.fetch(new Request("https://site.test/blog/hello", { headers: { cookie } }))
    expect(await preview.json()).toEqual({ bypass: true, title: "Draft" })
    expect(preview.headers.get("cache-control")).toBe("private, no-store")
    expect(preview.headers.get("x-robots-tag")).toBe("noindex, nofollow")

    expect(await (await nitroApp.fetch(new Request("https://site.test/posts", { headers: { cookie } }))).json()).toMatchObject({ total: 2 })
    expect(await (await nitroApp.fetch(new Request("https://site.test/posts"))).json()).toMatchObject({ total: 1 })
    expect(await titleOf(await nitroApp.fetch(new Request("https://site.test/api/content/get/posts/hello", { headers: { cookie } })))).toBe("Draft")
    expect(shouldBypassCache()).toBe(false)
  })

  it("scopes whole Nitro 2 requests through the generated plugin, isolated per request", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const beforeResponse: Array<(event: unknown) => void> = []
    // The shape of a Nitro 2 app: h3 v1 middleware has no next(), so the plugin wraps the app handler.
    const nitroApp = {
      h3App: {
        async handler(event: { node: { req: { headers: Record<string, string> }, res: ServerResponseLike } }) {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
          const title = (await posts.get("hello"))?.data.title
          event.node.res.setHeader("cache-control", "s-maxage=60")
          for (const hook of beforeResponse) hook(event)
          event.node.res.body = { bypass: shouldBypassCache(), title }
        },
      },
      hooks: { hook: (name: string, hook: (event: unknown) => void) => name === "beforeResponse" && beforeResponse.push(hook) },
    }
    defineContentPreviewPlugin(content)(nitroApp)

    const results = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const preview = index % 2 === 0
      const headers: Record<string, string> = preview ? { cookie } : {}
      const event = { node: { req: { headers }, res: serverResponse() } }
      await nitroApp.h3App.handler(event)
      return { preview, body: event.node.res.body, cacheControl: event.node.res.headers["cache-control"] }
    }))
    for (const result of results) {
      expect(result).toEqual(result.preview
        ? { preview: true, body: { bypass: true, title: "Draft" }, cacheControl: "private, no-store" }
        : { preview: false, body: { bypass: false, title: "Published" }, cacheControl: "s-maxage=60" })
    }
  })

  it("renders a preview frame form with its document in place of the draft, and stores nothing", async () => {
    const { content, posts } = await setup()
    const app = new H3()
      .get("/blog/hello", async event => ({
        url: event.req.url,
        method: event.req.method,
        get: (await posts.get("hello"))?.data.title,
        body: (await posts.get("hello"))?.body,
        list: (await posts.list()).items.map(item => item.data.title),
        published: (await posts.get("hello", { ref: "published" }))?.data.title,
        stored: (await posts.get("hello", { ref: "draft" }))?.data.title,
      }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello", maxAge: 120 })
    const frame = (form: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin", origin: "https://site.test" }) => nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify(form) }),
    }))

    const response = await frame({ token, document: { collection: "posts", id: "hello", data: { title: "On screen" }, body: "# Typed" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    // The draft-only post "new" stays out of the list: the token signs "hello" only.
    expect(await response.json()).toEqual({
      url: "https://site.test/blog/hello",
      method: "GET",
      get: "On screen",
      body: "# Typed",
      list: ["On screen"],
      published: "Published",
      stored: "Draft",
    })
    // The same form without a document renders the stored draft of "hello".
    expect(await (await frame({ token })).json()).toMatchObject({ get: "Draft", list: ["Draft"] })
    expect((await posts.get("hello", { ref: "draft" }))?.data.title).toBe("Draft")
    expect((await posts.get("hello"))?.data.title).toBe("Published")
  })

  it("follows same-origin redirects of a Nitro 3 preview frame inside its scope", async () => {
    const { content, posts } = await setup()
    const app = new H3()
      .get("/blog/old", () => Response.redirect("https://site.test/en/blog/hello", 301))
      .get("/en/blog/hello", () => new Response(null, { status: 302, headers: { location: "../../blog/hello?lang=en#top" } }))
      .get("/blog/away", () => Response.redirect("https://other.test/blog/hello", 302))
      .get("/blog/loop", () => new Response(null, { status: 302, headers: { location: "/blog/loop" } }))
      .get("/blog/hello", async event => ({ url: event.req.url, get: (await posts.get("hello"))?.data.title, frame: content.preview.frame()?.id }))
      .get("/blog/page", async () => new Response(`<!doctype html><html><head><title>t</title></head><body>${(await posts.get("hello"))?.data.title}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }))
      .get("/blog/to-page", () => new Response(null, { status: 302, headers: { location: "/blog/page?lang=en#intro" } }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const frame = (path: string, headers: Record<string, string> = {}) => nitroApp.fetch(new Request(`https://site.test${path}?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: "https://site.test", ...headers },
      body: frameForm(token),
    }))

    // A locale redirect, then a relative canonical one: the last page renders with the document on screen.
    const followed = await frame("/blog/old")
    expect(followed.status).toBe(200)
    expect(followed.headers.get("cache-control")).toBe("private, no-store")
    expect(await followed.json()).toEqual({ url: "https://site.test/blog/hello?lang=en", get: "On screen", frame: "hello" })
    // An HTML page gets the address it has after the redirect, with the fragment of the redirect.
    const page = await (await frame("/blog/to-page")).text()
    expect(page).toContain("<body>On screen</body>")
    expect(page).toContain(`<head><script>history.replaceState(history.state,"","/blog/page?lang=en&${contentPreviewFrameParameter}="+"#intro")</script><title>`)
    // A redirect to another origin cannot keep the document on screen: the frame gets the error page, never the site.
    const away = await frame("/blog/away")
    expect(away.status).toBe(502)
    expect(away.headers.get("location")).toBeNull()
    expect(away.headers.get("cache-control")).toBe("private, no-store")
    expect(await away.text()).toContain(`<meta name="${contentPreviewErrorName}" content="The page redirects to https://other.test, which is another site.`)
    // The host a proxy forwards is this server too: its first value, and the request never leaves this server.
    expect((await frame("/blog/away", { "x-forwarded-host": "other.test, proxy.test" })).status).toBe(200)
    expect((await frame("/blog/away", { "x-forwarded-host": "proxy.test, other.test" })).status).toBe(502)
    const proxied = await nitroApp.fetch(new Request(`https://internal.test/blog/away?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-host": "other.test" },
      body: frameForm(token),
    }))
    expect(await proxied.json()).toMatchObject({ url: "https://other.test/blog/hello", get: "On screen" })
    // A loop stops after five redirects with the error page.
    const loop = await frame("/blog/loop")
    expect(loop.status).toBe(502)
    expect(await loop.text()).toContain("redirects more than 5 times")
  })

  it("gives a cookie without Path from a followed redirect the default path of the page that set it", async () => {
    const { content } = await setup()
    const seen: Array<string | null> = []
    const app = new H3()
      .get("/blog/hello", () => new Response(null, { status: 302, headers: { location: "/auth/login" } }))
      .get("/auth/login", () => new Response(null, { status: 302, headers: { location: "/auth/account", "set-cookie": "session=abc; HttpOnly" } }))
      .get("/auth/account", (event) => {
        seen.push(event.req.headers.get("cookie"))
        const headers = new Headers({ "content-type": "application/json" })
        headers.append("set-cookie", "seen=1; Path=/blog/../auth")
        headers.append("set-cookie", "last=1")
        headers.append("set-cookie", "root=1; Path=/")
        return new Response("{}", { headers })
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: frameForm(token),
    }))
    expect(response.status).toBe(200)
    expect(seen).toEqual(["session=abc"])
    // The browser sets them from /blog/hello, so each gets the path of /auth, where the server set it.
    expect(response.headers.getSetCookie()).toEqual(["session=abc; HttpOnly; Path=/auth", "seen=1; Path=/blog/../auth", "last=1; Path=/auth", "root=1; Path=/"])
  })

  it("leaves cookie prefix rules to the browser: a __Host- cookie without Path=/ stays invalid", async () => {
    const { content } = await setup()
    const seen: Array<string | null> = []
    const app = new H3()
      .get("/blog/hello", () => new Response(null, { status: 302, headers: { location: "/auth/login" } }))
      .get("/auth/login", () => {
        const headers = new Headers({ location: "/auth/account" })
        headers.append("set-cookie", "__Host-bad=1; Secure")
        headers.append("set-cookie", "__Host-good=1; Secure; Path=/")
        headers.append("set-cookie", "__Secure-bad=1")
        return new Response(null, { status: 302, headers })
      })
      .get("/auth/account", (event) => {
        seen.push(event.req.headers.get("cookie"))
        return { ok: true }
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: frameForm(token),
    }))
    expect(seen).toEqual(["__Host-good=1"])
    // The invalid ones reach the browser unchanged, so it refuses them as it would on the redirect itself.
    expect(response.headers.getSetCookie()).toEqual(["__Host-bad=1; Secure", "__Host-good=1; Secure; Path=/", "__Secure-bad=1; Path=/auth"])
  })

  it("keeps a path-scoped cookie of a redirect for a later hop under its path, past a hop outside it", async () => {
    const { content } = await setup()
    const seen: Record<string, string | null> = {}
    const app = new H3()
      .get("/a/login", () => new Response(null, { status: 302, headers: { location: "/b/bounce", "set-cookie": "token=1; Path=/a" } }))
      .get("/b/bounce", (event) => {
        seen.bounce = event.req.headers.get("cookie")
        return new Response(null, { status: 302, headers: { location: "/a/home" } })
      })
      .get("/a/home", (event) => {
        seen.home = event.req.headers.get("cookie")
        return { ok: true }
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/a/login?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie: "keep=1" },
      body: frameForm(token),
    }))
    expect(response.status).toBe(200)
    expect(seen).toEqual({ bounce: "keep=1", home: "keep=1; token=1" })
  })

  it("keeps redirect cookies within their host or Domain scope across permitted hosts", async () => {
    const { content } = await setup()
    const seen: Record<string, string | null> = {}
    const app = new H3()
      .get("/a/login", () => {
        const headers = new Headers({ location: "/b/bounce" })
        headers.append("set-cookie", "session=internal; Path=/a")
        headers.append("set-cookie", "shared=host; Path=/a")
        headers.append("set-cookie", "shared=domain; Domain=site.test; Path=/a")
        headers.append("set-cookie", "limited=1; Domain=internal.site.test; Path=/a")
        return new Response(null, { status: 302, headers })
      })
      .get("/b/bounce", (event) => {
        seen.bounce = event.req.headers.get("cookie")
        return new Response(null, { status: 302, headers: { location: "https://public.site.test/a/account" } })
      })
      .get("/a/account", (event) => {
        seen.account = event.req.headers.get("cookie")
        return new Response(null, { status: 302, headers: { location: "https://internal.site.test/a/home", "set-cookie": "session=public; Path=/a" } })
      })
      .get("/a/home", (event) => {
        seen.home = event.req.headers.get("cookie")
        return { ok: true }
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://internal.site.test/a/login?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "x-forwarded-host": "public.site.test", cookie: "keep=1" },
      body: frameForm(token),
    }))
    expect(response.status).toBe(200)
    expect(seen).toEqual({
      bounce: "keep=1",
      account: "shared=domain",
      home: "keep=1; session=internal; shared=host; shared=domain; limited=1",
    })
  })

  it.each([
    ["internal.foo.co.uk", "public.bar.co.uk", "co.uk", "foo.co.uk"],
    ["internal.foo.github.io", "public.bar.github.io", "github.io", "foo.github.io"],
  ])("rejects public-suffix Domain cookies from %s across permitted hosts", async (internal, publicHost, suffix, domain) => {
    const { content } = await setup()
    const seen: Record<string, string | null> = {}
    const app = new H3()
      .get("/login", () => {
        const headers = new Headers({ location: "/bounce" })
        headers.append("set-cookie", `rejected=secret; Domain=${suffix}; Path=/`)
        headers.append("set-cookie", `accepted=1; Domain=${domain}; Path=/`)
        return new Response(null, { status: 302, headers })
      })
      .get("/bounce", (event) => {
        seen.bounce = event.req.headers.get("cookie")
        return Response.redirect(`https://${publicHost}/account`, 302)
      })
      .get("/account", (event) => {
        seen.account = event.req.headers.get("cookie")
        return Response.redirect(`https://${internal}/home`, 302)
      })
      .get("/home", (event) => {
        seen.home = event.req.headers.get("cookie")
        return { ok: true }
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://${internal}/login?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "x-forwarded-host": publicHost },
      body: frameForm(token),
    }))
    expect(response.status).toBe(200)
    expect(seen).toEqual({ bounce: "accepted=1", account: null, home: "accepted=1" })
  })

  it("keeps the cookies of redirects for the next page and the browser, on Nitro 3", async () => {
    const { content, posts } = await setup()
    const seen: Array<string | null> = []
    const app = new H3()
      .get("/login", () => {
        const headers = new Headers({ location: "/account/" })
        headers.append("set-cookie", "session=abc123; Path=/; HttpOnly; SameSite=Lax")
        headers.append("set-cookie", "theme=dark; Path=/; Max-Age=3600")
        headers.append("set-cookie", "legacy=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        headers.append("set-cookie", "other=x; Domain=elsewhere.test; Path=/")
        headers.append("set-cookie", "scoped=1; Path=/admin")
        return new Response(null, { status: 303, headers })
      })
      .get("/account/", async (event) => {
        seen.push(event.req.headers.get("cookie"))
        const session = /(?:^|; )session=([^;]*)/.exec(event.req.headers.get("cookie") ?? "")?.[1]
        if (!session) return Response.redirect("https://site.test/login", 302)
        return { session, title: (await posts.get("hello"))?.data.title, frame: content.preview.frame()?.id }
      })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/login?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie: "legacy=1; keep=yes" },
      body: frameForm(token),
    }))
    expect(response.status).toBe(200)
    // The cookie-dependent page reads the session the redirect set, and the document on screen.
    expect(await response.json()).toEqual({ session: "abc123", title: "On screen", frame: "hello" })
    expect(seen).toEqual(["keep=yes; session=abc123; theme=dark"])
    // The browser gets every cookie, in order, as if it had followed the redirect.
    expect(response.headers.getSetCookie()).toEqual([
      "session=abc123; Path=/; HttpOnly; SameSite=Lax",
      "theme=dark; Path=/; Max-Age=3600",
      "legacy=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "other=x; Domain=elsewhere.test; Path=/",
      "scoped=1; Path=/admin",
    ])
    // The same Cookie header outside a frame keeps the ordinary redirect, and nothing changes the cookie.
    const outside = await nitroApp.fetch(new Request("https://site.test/login", { headers: { cookie: "legacy=1; keep=yes" } }))
    expect(outside.status).toBe(303)
    expect(outside.headers.get("location")).toBe("/account/")
    expect(outside.headers.get("cache-control")).toBeNull()
  })

  it.each([false, true])("handles frame redirects without Headers.getSetCookie (sets cookie: %s)", async (setsCookie) => {
    const { content, posts } = await setup()
    const render = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/start") {
        const response = new Response(null, { status: 302, headers: {
          location: "/blog/hello",
          ...(setsCookie ? { "set-cookie": "locale=en; Path=/" } : {}),
        } })
        // Older Fetch hosts expose a combined Set-Cookie header without this newer method.
        Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
        return response
      }
      return Response.json({ title: (await posts.get("hello"))?.data.title, frame: content.preview.frame()?.id })
    })
    const nitroApp = { fetch: render }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/start?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://site.test" },
      body: new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token, document: { collection: "posts", id: "hello", data: { title: "On screen" } } }) }),
    }))
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    if (setsCookie) {
      // The joined header cannot be split safely, so the frame says it cannot follow instead of dropping the cookie.
      expect(response.status).toBe(502)
      expect(await response.text()).toContain(`<meta name="${contentPreviewErrorName}" content="The page redirects and sets cookies that this server cannot read one by one`)
      expect(render).toHaveBeenCalledOnce()
    }
    else {
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ title: "On screen", frame: "hello" })
      expect(render).toHaveBeenCalledTimes(2)
    }
  })

  it("lets a frame token read the draft of its one document, and no other draft through any read", async () => {
    vi.stubEnv("VITEHUB_CONTENT_KEY", key)
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }),
        pages: documents({ path: "pages/**/*.md", fields: { title: z.string() } }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    const pages = content.collection("pages")
    // A: the post the editor may read. B: another post. C: a page in another collection. Each has a private draft.
    await posts.save("a", { data: { title: "A published" }, body: "A" })
    await posts.save("b", { data: { title: "B published" }, body: "B" })
    await pages.save("c", { data: { title: "C published" }, body: "C" })
    await content.publish()
    await posts.save("a", { data: { title: "A draft" }, body: "A" })
    await posts.save("b", { data: { title: "B draft" }, body: "B secret" })
    await posts.save("b-unpublished", { data: { title: "B unpublished" }, body: "B" })
    await pages.save("c", { data: { title: "C draft" }, body: "C secret" })
    await pages.save("c-unpublished", { data: { title: "C unpublished" }, body: "C" })

    const contentApi = new H3().all("/api/content/**", defineContentHandler(content))
    const app = new H3()
      .get("/page", async () => ({
        active: content.preview.active(),
        a: (await posts.get("a"))?.data.title,
        b: (await posts.get("b"))?.data.title,
        bUnpublished: (await posts.get("b-unpublished"))?.data.title ?? null,
        c: (await pages.get("c"))?.data.title,
        cUnpublished: (await pages.get("c-unpublished"))?.data.title ?? null,
        posts: (await posts.list()).items.map(item => item.data.title),
        page: (await posts.page({ query: {} })).items.map(item => item.id),
        pages: (await pages.list()).items.map(item => item.data.title),
        raw: (await posts.raw("b"))?.text.includes("B secret"),
        hub: (await content.get("/posts/b"))?.data.title,
        hubList: (await content.list(["posts", "pages"])).map(item => item.path).sort(),
        navigation: JSON.stringify(await content.navigation(["posts", "pages"])).includes("unpublished"),
        search: JSON.stringify(await content.search(["posts", "pages"], "secret")).includes("secret"),
        api: await titleOf(await contentApi.request("/api/content/get/posts/b")),
      }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "a" })
    const frame = (form: unknown) => nitroApp.fetch(new Request(`https://site.test/page?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: "https://site.test" },
      body: new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify(form) }),
    }))
    const published = {
      active: false,
      b: "B published",
      bUnpublished: null,
      c: "C published",
      cUnpublished: null,
      pages: ["C published"],
      raw: false,
      hub: "B published",
      hubList: ["/pages/c", "/posts/a", "/posts/b"],
      navigation: false,
      search: false,
      api: "B published",
    }

    const posted = await frame({ token, document: { collection: "posts", id: "a", data: { title: "A on screen" }, body: "A" } })
    expect(posted.status).toBe(200)
    expect(await posted.json()).toEqual({ ...published, a: "A on screen", posts: ["A on screen", "B published"], page: ["a", "b"] })
    expect(await (await frame({ token })).json()).toEqual({ ...published, a: "A draft", posts: ["A draft", "B published"], page: ["a", "b"] })

    // A forged document for B or C is refused whole, and its token does not reveal their stored drafts either.
    for (const document of [
      { collection: "posts", id: "b", data: { title: "Forged" } },
      { collection: "posts", id: "b-unpublished", data: { title: "Forged" } },
      { collection: "pages", id: "c", data: { title: "Forged" } },
      { collection: "pages", id: "a", data: { title: "Forged" } },
    ]) {
      expect((await frame({ token, document })).status).toBe(403)
    }
    // A form field other than `document` carries nothing into the page.
    expect(await (await frame({ token, documents: [{ collection: "posts", id: "b", data: { title: "Forged" } }] })).json()).toMatchObject({ a: "A draft", b: "B published" })
    // A token signed for B cannot be moved to A by editing its document part.
    const other = (await content.preview.sign({ collection: "posts", id: "b" })).token.split(".")
    const moved = [other[0], other[1], token.split(".")[2], other[3]].join(".")
    expect((await frame({ token: moved })).status).toBe(403)
    // A frame token in the preview cookie previews nothing.
    expect(await titleOf(await contentApi.request("/api/content/get/posts/a", { headers: { cookie: `${contentPreviewCookieName}=${token}` } }))).toBe("A published")
  })

  it("refuses preview frames without a valid token or from another site", async () => {
    const { content } = await setup()
    const handler = vi.fn(() => "page")
    const app = new H3().get("/blog/hello", handler)
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const post = (form: string, headers: Record<string, string> = {}) => nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: form,
    }))
    const field = (value: unknown) => new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify(value) }).toString()
    const [version, expires, scope, signature] = token.split(".")
    const forged = `${version}.${Number(expires) + 600}.${scope}.${signature}`
    const cookieToken = tokenOf(await previewCookie(content))

    expect((await post(field({ token: forged }))).status).toBe(403)
    expect((await post(field({ token: "garbage" }))).status).toBe(403)
    expect((await post("not a form")).status).toBe(403)
    expect((await post(field({ token, document: { collection: "posts", id: "hello", data: [] } }))).status).toBe(403)
    // A server-wide cookie token is not a frame token, and a frame token is not a cookie token.
    expect((await post(field({ token: cookieToken }))).status).toBe(403)
    expect((await post(field({ token: `v1.${expires}.${signature}` }))).status).toBe(403)
    expect((await post(field({ token }), { "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect((await post(field({ token }), { origin: "https://evil.test" })).status).toBe(403)
    // A cookie does not stand in for the form token.
    expect((await post(field({}), { cookie: await previewCookie(content) })).status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect((await post(field({ token }), { "sec-fetch-site": "same-origin" })).status).toBe(200)
    // A Web Request has a full URL, so a forwarded protocol does not change the origin it is checked against.
    expect((await post(field({ token }), { "sec-fetch-site": "same-origin", origin: "https://site.test", "x-forwarded-proto": "http" })).status).toBe(200)
    expect((await post(field({ token }), { "sec-fetch-site": "same-origin", origin: "http://site.test", "x-forwarded-proto": "http" })).status).toBe(403)
    // The parameter on a GET grants nothing.
    const page = await nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`))
    expect(page.headers.get("cache-control")).toBeNull()
    vi.useFakeTimers({ now: Date.now() + 3601_000, toFake: ["Date"] })
    expect((await post(field({ token }), { "sec-fetch-site": "same-origin" })).status).toBe(403)
  })

  it("counts a Nitro 3 frame body as it streams, stops over 1 MiB, and reads no body from another site", async () => {
    const { content } = await setup()
    const app = new H3().get("/blog/hello", async event => ({ method: event.req.method }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const form = (body: string) => new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token, document: { collection: "posts", id: "hello", data: { title: "On screen" }, body } }) }).toString()
    /** A body that streams `chunks` one pull at a time, and records how far it was read. */
    function stream(chunks: Uint8Array[], options: { fail?: boolean } = {}) {
      const read = { pulls: 0, cancelled: false }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (options.fail && read.pulls === 2) return controller.error(new Error("connection reset"))
          const chunk = chunks[read.pulls++]
          if (chunk) controller.enqueue(chunk)
          else controller.close()
        },
        cancel() {
          read.cancelled = true
        },
      }, { highWaterMark: 0 })
      return { body, read }
    }
    const post = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers },
      body,
      // A streamed request body needs `duplex`.
      duplex: "half",
    }))
    const kib = (count: number) => new Uint8Array(count * 1024).fill(0x61)

    // Chunked, without Content-Length: 40 chunks of 64 KiB stop after 1 MiB, and the rest is cancelled.
    const chunked = stream(Array.from({ length: 40 }, () => kib(64)))
    expect((await post(chunked.body)).status).toBe(403)
    expect(chunked.read.pulls).toBeLessThanOrEqual(18)
    expect(chunked.read.cancelled).toBe(true)
    // A small declared length is not trusted.
    const dishonest = stream(Array.from({ length: 40 }, () => kib(64)))
    expect((await post(dishonest.body, { "content-length": "10" })).status).toBe(403)
    expect(dishonest.read.pulls).toBeLessThanOrEqual(18)
    expect(dishonest.read.cancelled).toBe(true)
    // The limit counts bytes, not characters: 400 Ki of "é" is 800 KiB of text, and its form encoding is 2.4 MiB.
    const multibyte = new TextEncoder().encode(form("é".repeat(400 * 1024)))
    expect(multibyte.byteLength).toBeGreaterThan(1024 * 1024)
    expect("é".repeat(400 * 1024).length).toBeLessThan(1024 * 1024)
    expect((await post(stream([multibyte]).body)).status).toBe(403)
    // A valid form under the limit renders, also when it arrives in many small chunks.
    const valid = new TextEncoder().encode(form("a".repeat(900 * 1024)))
    expect(valid.byteLength).toBeLessThan(1024 * 1024)
    const pieces = Array.from({ length: Math.ceil(valid.byteLength / 4096) }, (_, index) => valid.subarray(index * 4096, (index + 1) * 4096))
    const response = await post(stream(pieces).body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ method: "GET" })
    // A broken body is refused, and the request does not throw.
    expect((await post(stream([kib(1), kib(1), kib(1)], { fail: true }).body)).status).toBe(403)
    // A form from another site is refused before any of its body is read.
    const foreign = stream([new TextEncoder().encode(form("x"))])
    expect((await post(foreign.body, { "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect(foreign.read).toEqual({ pulls: 0, cancelled: true })
  })

  it("stops reading a Nitro 2 frame body over 1 MiB, and reads no body from another site", async () => {
    const { content } = await setup()
    const handler = vi.fn(async (_event: unknown) => undefined)
    const nitroApp = { h3App: { handler }, hooks: { hook: () => undefined } }
    defineContentPreviewPlugin(content)(nitroApp)
    function nodeRequest(chunks: number, headers: Record<string, string> = {}) {
      const read = { chunks: 0, destroyed: false }
      const request = Object.assign(Readable.from((function* () {
        for (; read.chunks < chunks; read.chunks++) yield new Uint8Array(64 * 1024).fill(0x61)
      })(), { highWaterMark: 1 }), { method: "POST", url: `/blog/hello?${contentPreviewFrameParameter}`, headers: { host: "site.test", "sec-fetch-site": "same-origin", ...headers } })
      request.on("close", () => {
        read.destroyed = true
      })
      return { read, request }
    }
    const response = () => Object.assign(serverResponse(), { statusCode: 200, end: vi.fn((_body: unknown, done: () => void) => done()) })

    const large = nodeRequest(40)
    const largeResponse = response()
    await nitroApp.h3App.handler({ node: { req: large.request, res: largeResponse } })
    expect(largeResponse.statusCode).toBe(403)
    expect(largeResponse.headers.connection).toBe("close")
    expect(large.read.chunks).toBeLessThanOrEqual(19)
    await new Promise(resolve => setImmediate(resolve))
    expect(large.read.destroyed).toBe(true)
    const foreign = nodeRequest(1, { "sec-fetch-site": "cross-site" })
    const foreignResponse = response()
    await nitroApp.h3App.handler({ node: { req: foreign.request, res: foreignResponse } })
    expect(foreignResponse.statusCode).toBe(403)
    expect(foreign.read.chunks).toBe(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it("closes a Nitro 2 connection after refusing a slow upload from another site, without reading it", async () => {
    const { content } = await setup()
    const handler = vi.fn(async () => undefined)
    const nitroApp = { h3App: { handler }, hooks: { hook: () => undefined } }
    defineContentPreviewPlugin(content)(nitroApp)
    let serverRequest: import("node:http").IncomingMessage | undefined
    // SAFETY: The plugin replaced the handler with one that takes an h3 v1 event.
    const server = createServer((req, res) => {
      serverRequest = req
      void (nitroApp.h3App.handler as (event: unknown) => Promise<unknown>)({ node: { req, res } })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const { port } = server.address() as AddressInfo
    // A chunked upload that never ends on its own: 16 KiB every 10 ms.
    const outcome = await new Promise<{ status?: number, closed: boolean, sentKiB: number }>((resolve) => {
      let sent = 0
      let status: number | undefined
      const upload = httpRequest({ host: "127.0.0.1", port, method: "POST", path: `/blog/hello?${contentPreviewFrameParameter}`, headers: { "transfer-encoding": "chunked", "sec-fetch-site": "cross-site" } }, (response) => {
        status = response.statusCode
        response.resume()
      })
      const timer = setInterval(() => {
        sent += 16
        upload.write(new Uint8Array(16 * 1024))
      }, 10)
      const done = (closed: boolean) => {
        clearInterval(timer)
        upload.destroy()
        resolve({ status, closed, sentKiB: sent })
      }
      upload.on("close", () => done(true))
      upload.on("error", () => undefined)
      setTimeout(() => done(false), 3000)
    })
    expect(outcome.status).toBe(403)
    expect(outcome.closed).toBe(true)
    expect(serverRequest?.destroyed).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it("renders preview frames on Nitro 2 as an in-process GET of the page, answered once on the connection", async () => {
    const { content, posts } = await setup()
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const seen: Array<{ method?: string, url?: string, contentType: unknown, title: unknown }> = []
    const nitroApp = await nitro2Server(async (request) => {
      seen.push({ method: request.method, url: request.url, contentType: request.headers["content-type"], title: (await posts.get("hello"))?.data.title })
      return { headers: { "content-type": "application/json" }, body: JSON.stringify({ title: (await posts.get("hello"))?.data.title }) }
    })
    defineContentPreviewPlugin(content)(nitroApp)
    const base = await listen(nitroApp)
    const response = await fetch(`${base}/blog/hello?lang=en&${contentPreviewFrameParameter}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: frameForm(token) })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toEqual({ title: "On screen" })
    expect(seen).toEqual([{ method: "GET", url: "/blog/hello?lang=en", contentType: undefined, title: "On screen" }])
    expect(nitroApp.calls).toMatchObject([{ method: "GET", url: "/blog/hello?lang=en", protocol: "http" }])
  })

  it("follows same-origin redirects of a Nitro 2 preview frame in its scope, with their cookies, and stops at another site", async () => {
    const { content, posts } = await setup()
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    let base = ""
    const pages: Record<string, (request: NodeRequestLike) => NodePage | Promise<NodePage>> = {
      // A Nuxt route rule redirect and h3 sendRedirect() write the head and an HTML body on the Node response.
      "/blog/old": () => ({ status: 301, headers: { location: "/en/blog/hello" }, body: "<!DOCTYPE html><html><head><meta http-equiv=\"refresh\" content=\"0; url=/en/blog/hello\"></head></html>" }),
      "/en/blog/hello": () => ({ status: 302, headers: { location: `${base}/account?lang=en#top`, "set-cookie": ["session=abc; Path=/; HttpOnly", "locale=en; Path=/; Max-Age=600"] } }),
      "/account": async (request): Promise<NodePage> => {
        const cookie = String(request.headers.cookie ?? "")
        if (!cookie.includes("session=abc")) return { status: 302, headers: { location: "/blog/old" } }
        return { headers: { "content-type": "text/html;charset=utf-8" }, body: `<html><head></head><body><h1>${(await posts.get("hello"))?.data.title}</h1><p>${cookie}</p></body></html>` }
      },
      "/blog/away": () => ({ status: 302, headers: { location: "https://other.test/blog/hello", "set-cookie": "away=1; Path=/" } }),
      "/blog/loop": () => ({ status: 307, headers: { location: "/blog/loop" } }),
      // A handler that returns a Web Response, which h3 v1 sends as a stream.
      "/blog/stream": async () => ({ headers: { "content-type": "text/html" }, body: new Response(`<html><head></head><body>${(await posts.get("hello"))?.data.title}</body></html>`).body! }),
      "/blog/to-stream": () => ({ status: 302, headers: { location: "/blog/stream" } }),
    }
    const nitroApp = await nitro2Server(request => pages[String(request.url).split("?", 1)[0]!]?.(request) ?? { status: 404 })
    defineContentPreviewPlugin(content)(nitroApp)
    base = await listen(nitroApp)
    const frame = (path: string, cookie?: string) => fetch(`${base}${path}?${contentPreviewFrameParameter}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: base, ...cookie ? { cookie } : {} },
      body: frameForm(token),
    })

    const followed = await frame("/blog/old", "prefs=1")
    expect(followed.status).toBe(200)
    expect(followed.headers.get("cache-control")).toBe("private, no-store")
    expect(followed.headers.getSetCookie()).toEqual(["session=abc; Path=/; HttpOnly", "locale=en; Path=/; Max-Age=600"])
    const html = await followed.text()
    expect(html).toContain("<h1>On screen</h1><p>prefs=1; session=abc; locale=en</p>")
    expect(html).toContain(`<head><script>history.replaceState(history.state,"","/account?lang=en&${contentPreviewFrameParameter}="+"#top")</script></head>`)
    expect(nitroApp.calls.map(call => call.url)).toEqual(["/blog/old", "/en/blog/hello", "/account?lang=en"])

    expect(await (await frame("/blog/stream")).text()).toBe("<html><head></head><body>On screen</body></html>")
    expect(await (await frame("/blog/to-stream")).text()).toContain("<body>On screen</body>")

    const away = await frame("/blog/away")
    expect(away.status).toBe(502)
    expect(away.headers.get("location")).toBeNull()
    expect(away.headers.getSetCookie()).toEqual(["away=1; Path=/"])
    expect(await away.text()).toContain(`<meta name="${contentPreviewErrorName}"`)
    expect((await frame("/blog/loop")).status).toBe(502)

    // Concurrent frames and ordinary requests on the same connection pool stay apart.
    const reads = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      if (index % 2) return { frame: false, text: await (await fetch(`${base}/account`, { headers: { cookie: "session=abc" } })).text() }
      return { frame: true, text: await (await frame("/blog/old")).text() }
    }))
    for (const read of reads) expect(read.text).toContain(read.frame ? "<h1>On screen</h1>" : "<h1>Published</h1>")
  })

  it("checks a Nitro 2 frame Origin against the public protocol, from TLS or a proxy, and never from Origin", async () => {
    const { content } = await setup()
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const rendered = vi.fn(() => ({ body: "page" }))
    const nitroApp = await nitro2Server(rendered)
    defineContentPreviewPlugin(content)(nitroApp)
    const body = new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token }) }).toString()
    async function post(headers: Record<string, string>, encrypted: boolean) {
      rendered.mockClear()
      const request = Object.assign(Readable.from([new TextEncoder().encode(body)]), { method: "POST", url: `/blog/hello?${contentPreviewFrameParameter}`, socket: { encrypted }, headers: { host: "site.test", "sec-fetch-site": "same-origin", ...headers } })
      const response = Object.assign(serverResponse(), { statusCode: 0, end: vi.fn((_body: unknown, done: () => void) => done()) })
      // SAFETY: The plugin replaced the handler with one that takes an h3 v1 event.
      await (nitroApp.h3App.handler as (event: unknown) => Promise<unknown>)({ node: { req: request, res: response } })
      return rendered.mock.calls.length === 1 ? response.statusCode : response.statusCode === 403 ? 403 : 0
    }
    // Direct TLS, and HTTPS that a reverse proxy ends before a plain HTTP socket.
    expect(await post({ origin: "https://site.test" }, true)).toBe(200)
    expect(nitroApp.calls.at(-1)).toMatchObject({ url: "/blog/hello", protocol: "https", headers: { host: "site.test" } })
    expect(await post({ origin: "https://site.test", "x-forwarded-proto": "https" }, false)).toBe(200)
    expect(await post({ origin: "http://site.test" }, false)).toBe(200)
    // Another site, another protocol, or another port is refused, whatever the Origin claims.
    expect(await post({ origin: "https://evil.test" }, true)).toBe(403)
    expect(await post({ origin: "https://evil.test", "x-forwarded-proto": "https" }, false)).toBe(403)
    expect(await post({ origin: "http://site.test" }, true)).toBe(403)
    expect(await post({ origin: "http://site.test", "x-forwarded-proto": "https" }, false)).toBe(403)
    expect(await post({ origin: "https://site.test" }, false)).toBe(403)
    expect(await post({ origin: "https://site.test", "x-forwarded-proto": "http" }, true)).toBe(403)
    expect(await post({ origin: "https://site.test:8443" }, true)).toBe(403)
    expect(await post({ origin: "https://site.test", "sec-fetch-site": "cross-site" }, true)).toBe(403)
  })

  it("sets and clears a secure, HttpOnly, SameSite=Strict cookie through an H3 event", async () => {
    const { content } = await setup()
    const app = new H3()
      .post("/preview", async event => await content.preview.enable(event))
      .post("/preview/short", async event => await content.preview.enable(event, { maxAge: 120 }))
      .delete("/preview", event => content.preview.disable(event))

    const enabled = await app.request("https://site.test/preview", { method: "POST" })
    const setCookie = enabled.headers.get("set-cookie")!
    expect(setCookie).toMatch(new RegExp(`^${contentPreviewCookieName}=v1\\.\\d+\\.[\\w-]{43}; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict; Secure$`))
    expect(enabled.headers.get("cache-control")).toBe("private, no-store")
    const body = await enabled.json()
    expect(body).toEqual({ setCookie, expiresAt: expect.any(String) })
    expect(Date.parse(Reflect.get(Object(body), "expiresAt")) - Date.now()).toBeGreaterThan(3_590_000)

    expect((await app.request("https://site.test/preview/short", { method: "POST" })).headers.get("set-cookie")).toContain("Max-Age=120;")
    expect((await app.request("http://localhost:3000/preview", { method: "POST" })).headers.get("set-cookie")).not.toContain("Secure")
    expect((await app.request("http://internal/preview", { method: "POST", headers: { "x-forwarded-proto": "https" } })).headers.get("set-cookie")).toContain("; Secure")

    const disabled = await app.request("https://site.test/preview", { method: "DELETE" })
    expect(disabled.headers.get("set-cookie")).toBe(`${contentPreviewCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure`)
    expect(await disabled.json()).toEqual({ setCookie: disabled.headers.get("set-cookie"), expiresAt: null })

    await expect(content.preview.enable(new Request("https://site.test/"), { maxAge: 10 })).rejects.toMatchObject({ code: "CONTENT_R0008" })
    await expect(content.preview.enable(new Request("https://site.test/"), { maxAge: 90_000 })).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("fails closed in production without VITEHUB_CONTENT_KEY", async () => {
    const { content } = await setup()
    const app = contentApp(content)
    const cookie = await previewCookie(content)

    vi.stubEnv("VITEHUB_CONTENT_KEY", "")
    vi.stubEnv("NODE_ENV", "production")
    await expect(content.preview.enable(new Request("https://site.test/"))).rejects.toMatchObject({ code: "CONTENT_R0010" })
    const response = await app.request("/api/content/get/posts/hello", { headers: { cookie } })
    expect(await response.json()).toMatchObject({ data: { title: "Published" } })
    expect(response.headers.get("cache-control")).toBeNull()

    vi.stubEnv("VITEHUB_CONTENT_KEY", "too-short")
    await expect(content.preview.enable(new Request("https://site.test/"))).rejects.toMatchObject({ code: "CONTENT_R0010" })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await (await app.request("/api/content/get/posts/hello", { headers: { cookie } })).json()).toMatchObject({ data: { title: "Published" } })
    warn.mockRestore()
  })

  it("uses a per-process key in development and tests without VITEHUB_CONTENT_KEY", async () => {
    const { content } = await setup()
    vi.stubEnv("VITEHUB_CONTENT_KEY", "")
    const cookie = await previewCookie(content)
    const request = new Request("https://site.test/", { headers: { cookie } })
    expect(await content.preview.run(request, () => content.preview.active())).toBe(true)
  })

  it("is unavailable without collections and leaves Source-only requests unchanged", async () => {
    const content = defineContent({ source: { items: async () => [{ key: "index.md", content: "# Home" }] }, logger: false })
    cleanup.push(() => content.dispose())
    await expect(content.preview.enable(new Request("https://site.test/"))).rejects.toMatchObject({ code: "CONTENT_R0008" })
    const request = new Request("https://site.test/", { headers: { cookie: `${contentPreviewCookieName}=v1.1.x` } })
    expect(await content.preview.run(request, () => content.preview.active())).toBe(false)
  })
})

/**
 * Posts A and B and page C, each published and then changed in the draft, plus drafts that were never published. A
 * Nitro 3 app with a page that reads them every way, `/api/content/**`, and a nested request with the same cookie.
 */
async function publishedSite() {
  vi.stubEnv("VITEHUB_CONTENT_KEY", key)
  const workspace = await historyWorkspace()
  const content = defineContent({
    workspace,
    collections: {
      posts: documents({ path: "posts/**/*.md", fields: { title: z.string() } }),
      pages: documents({ path: "pages/**/*.md", fields: { title: z.string() } }),
    },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  const posts = content.collection("posts")
  const pages = content.collection("pages")
  await posts.save("a", { data: { title: "A published" }, body: "A body" })
  await posts.save("b", { data: { title: "B published" }, body: "B body" })
  await pages.save("c", { data: { title: "C published" }, body: "C body" })
  await content.publish()
  await posts.save("a", { data: { title: "A draft" }, body: "A secret" })
  await posts.save("b", { data: { title: "B draft" }, body: "B secret" })
  await posts.save("b-unpublished", { data: { title: "B unpublished" }, body: "B" })
  await pages.save("c", { data: { title: "C draft" }, body: "C secret" })
  const cookie = await previewCookie(content)
  const nitroApp: { fetch: (request: Request) => Promise<Response> | Response, h3: H3 } = { fetch: request => app.fetch(request), h3: undefined! }
  const app: H3 = new H3()
    .get("/page", async event => ({
      url: event.req.url,
      active: content.preview.active(),
      bypass: shouldBypassCache(),
      a: (await posts.get("a"))?.data.title,
      aBody: (await posts.get("a"))?.body,
      b: (await posts.get("b"))?.data.title,
      bUnpublished: (await posts.get("b-unpublished"))?.data.title ?? null,
      c: (await pages.get("c"))?.data.title,
      posts: (await posts.list()).items.map(item => item.data.title),
      hub: (await content.get("/posts/b"))?.data.title,
      // A route that runs preview itself, and a nested request with the browser's cookie, such as SSR data fetching.
      run: await content.preview.run(event, async () => (await pages.get("c"))?.data.title),
      nested: await titleOf(await nitroApp.fetch(new Request("https://site.test/api/content/get/posts/b", { headers: { cookie } }))),
    }))
    // A locale redirect to a relative path, then a canonical redirect that keeps its own query and fragment.
    .get("/en", () => redirect("old"))
    .get("/old", () => redirect("/page?lang=en#top", 301))
    .get("/canonical", () => redirect("https://SITE.test/page"))
    // A fetch() response has immutable headers.
    .get("/frozen", () => Response.redirect("https://site.test/page", 307))
    .get("/away", () => redirect("https://other.test/page?x=1"))
    .all("/api/content/**", defineContentHandler(content))
  nitroApp.h3 = app
  defineContentPreviewPlugin(content)(nitroApp)
  const drafts = { active: true, bypass: true, a: "A draft", aBody: "A secret", b: "B draft", bUnpublished: "B unpublished", c: "C draft", posts: ["A draft", "B draft", "B unpublished"], hub: "B draft", run: "C draft", nested: "B draft" }
  const published = { active: false, bypass: true, a: "A published", aBody: "A body", b: "B published", bUnpublished: null, c: "C published", posts: ["A published", "B published"], hub: "B published", run: "C published", nested: "B published" }
  return { content, posts, cookie, nitroApp, drafts, published }
}

describe("published reads with a whole-site preview cookie", { timeout: 30_000 }, () => {
  it("reads published title, body, and related data with ?vitehub-content-published, and leaves the cookie session working", async () => {
    const { cookie, nitroApp, drafts, published } = await publishedSite()
    const marked = `https://site.test/page?${contentPreviewPublishedParameter}`
    const response = await nitroApp.fetch(new Request(marked, { headers: { cookie } }))
    expect(await response.json()).toEqual({ ...published, url: marked })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    // The cookie stays as it is: nothing clears or replaces it.
    expect(response.headers.get("set-cookie")).toBeNull()
    // The same cookie on a request without the parameter previews the whole site, as before.
    expect(await (await nitroApp.fetch(new Request("https://site.test/page", { headers: { cookie } }))).json()).toEqual({ ...drafts, url: "https://site.test/page" })
    expect(shouldBypassCache()).toBe(false)
  })

  it("reads published in a fetch from the published page, by its same-origin Referer only", async () => {
    const { cookie, nitroApp } = await publishedSite()
    const api = (referer: string) => nitroApp.fetch(new Request("https://site.test/api/content/get/posts/b", { headers: { cookie, referer } }))
    expect(await titleOf(await api(`https://site.test/page?${contentPreviewPublishedParameter}`))).toBe("B published")
    expect(await titleOf(await api("https://site.test/page"))).toBe("B draft")
    // Another origin cannot change what this site reads.
    expect(await titleOf(await api(`https://other.test/page?${contentPreviewPublishedParameter}`))).toBe("B draft")
  })

  it("keeps redirects of a published request published, and leaves redirects of the cookie session as they are", async () => {
    const { cookie, nitroApp, drafts, published } = await publishedSite()
    const marked = contentPreviewPublishedParameter
    /** Follows redirects as a browser does: the cookie on every hop, and the Location resolved against the last URL. */
    async function follow(url: string, headers: Record<string, string> = {}) {
      const locations: Array<string | null> = []
      for (;;) {
        // A browser does not send the fragment.
        const response = await nitroApp.fetch(new Request(url.split("#", 1)[0]!, { headers: { cookie, ...headers } }))
        if (response.status < 300 || response.status >= 400) return { locations, url, body: await response.json() }
        // Draft and published redirects alike depend on the cookie, so no cache keeps them.
        expect(response.headers.get("cache-control")).toBe("private, no-store")
        locations.push(response.headers.get("location"))
        url = new URL(response.headers.get("location")!, url).href
        if (url.startsWith("https://other.test")) return { locations, url, body: undefined }
      }
    }
    expect(await follow(`https://site.test/en?${marked}`)).toEqual({
      locations: [`old?${marked}`, `/page?lang=en&${marked}#top`],
      url: `https://site.test/page?lang=en&${marked}#top`,
      body: { ...published, url: `https://site.test/page?lang=en&${marked}` },
    })
    expect((await follow(`https://site.test/canonical?${marked}`)).locations).toEqual([`https://SITE.test/page?${marked}`])
    const frozen = await follow(`https://site.test/frozen?${marked}`)
    expect(frozen).toMatchObject({ locations: [`https://site.test/page?${marked}`], body: { ...published, url: `https://site.test/page?${marked}` } })
    // A fetch() from the published page is published by its Referer, and so is the page it redirects to.
    expect(await follow("https://site.test/old", { referer: `https://site.test/page?${marked}` })).toMatchObject({ locations: [`/page?lang=en&${marked}#top`], body: published })
    // Another host gets the redirect unchanged.
    expect(await follow(`https://site.test/away?${marked}`)).toEqual({ locations: ["https://other.test/page?x=1"], url: "https://other.test/page?x=1", body: undefined })
    // The same cookie without the parameter previews the destination, with the redirects unchanged.
    expect(await follow("https://site.test/en")).toEqual({
      locations: ["old", "/page?lang=en#top"],
      url: "https://site.test/page?lang=en#top",
      body: { ...drafts, url: "https://site.test/page?lang=en" },
    })
  })

  it("keeps Node redirects of a published request published on Nitro 2, with the host of a proxy", async () => {
    const { content, posts, cookie } = await publishedSite()
    const handler = async (event: { node: { req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse } }) => {
      const { req, res } = event.node
      const path = req.url!.split("?", 1)[0]
      // h3 v1 sendRedirect(): the status and Location, then end().
      if (path === "/old") {
        res.statusCode = 302
        res.setHeader("location", "/page?lang=en#top")
        return res.end("<meta http-equiv=\"refresh\" content=\"0; url=/page?lang=en\">")
      }
      if (path === "/en") return res.writeHead(301, { Location: "/old" }).end()
      if (path === "/public") return res.writeHead(308, { location: "https://site.test/page" }).end()
      if (path === "/away") return res.writeHead(302, { location: "https://other.test/page" }).end()
      // Node also takes the headers as one flat list of names and values.
      if (path === "/raw") return res.writeHead(302, ["Location", "/page", "X-Hop", "raw"]).end()
      if (path === "/raw-away") return res.writeHead(302, ["location", "https://other.test/page"]).end()
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ url: req.url, active: content.preview.active(), a: (await posts.get("a"))?.data.title, b: (await content.preview.run(event, async () => (await posts.get("b"))?.data.title)) }))
    }
    const nitroApp = { h3App: { handler }, hooks: { hook: () => undefined } }
    defineContentPreviewPlugin(content)(nitroApp)
    // SAFETY: The plugin replaced the handler with one that takes the same event.
    const server = createServer((req, res) => void (nitroApp.h3App.handler as typeof handler)({ node: { req, res } }))
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const marked = contentPreviewPublishedParameter
    const location = async (path: string, headers: Record<string, string> = {}) =>
      (await fetch(`${origin}${path}`, { headers: { cookie, ...headers }, redirect: "manual" })).headers.get("location")
    expect(await location(`/en?${marked}`)).toBe(`/old?${marked}`)
    expect(await location(`/old?${marked}`)).toBe(`/page?lang=en&${marked}#top`)
    expect(await location(`/public?${marked}`)).toBe("https://site.test/page")
    expect(await location(`/public?${marked}`, { "x-forwarded-host": "site.test", "x-forwarded-proto": "https" })).toBe(`https://site.test/page?${marked}`)
    expect(await location(`/away?${marked}`)).toBe("https://other.test/page")
    expect(await location(`/raw?${marked}`)).toBe(`/page?${marked}`)
    expect(await location(`/raw-away?${marked}`)).toBe("https://other.test/page")
    expect(await location("/en")).toBe("/old")
    expect(await location("/raw")).toBe("/page")
    // fetch() follows the redirects with the cookie, as a browser does.
    const followed = await fetch(`${origin}/en?${marked}`, { headers: { cookie } })
    expect(followed.headers.get("cache-control")).toBe("private, no-store")
    expect(await followed.json()).toEqual({ url: `/page?lang=en&${marked}`, active: false, a: "A published", b: "B published" })
    expect(await (await fetch(`${origin}/en`, { headers: { cookie } })).json()).toEqual({ url: "/page?lang=en", active: true, a: "A draft", b: "B draft" })
  })

  it("keeps a draft frame of A to its one document, even with the whole-site cookie and nested preview runs", async () => {
    const { content, cookie, nitroApp, published } = await publishedSite()
    const { token } = await content.preview.sign({ collection: "posts", id: "a" })
    const response = await nitroApp.fetch(new Request(`https://site.test/page?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: "https://site.test" },
      body: new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token, document: { collection: "posts", id: "a", data: { title: "A on screen" }, body: "A typed" } }) }),
    }))
    expect(response.status).toBe(200)
    // Only A is a draft. B and C, the nested request, and the route's own preview.run() stay published.
    expect(await response.json()).toEqual({ ...published, url: "https://site.test/page", a: "A on screen", aBody: "A typed", posts: ["A on screen", "B published"] })
  })

  it("gives the parameter no draft access without a cookie or token, and accepts no document with it", async () => {
    const { nitroApp, published } = await publishedSite()
    const document = encodeURIComponent(JSON.stringify({ document: { collection: "posts", id: "b", data: { title: "Forged" } } }))
    for (const url of [
      `https://site.test/page?${contentPreviewPublishedParameter}`,
      `https://site.test/page?${contentPreviewPublishedParameter}=${document}`,
      `https://site.test/page?${contentPreviewPublishedParameter}&${contentPreviewFrameParameter}=${document}`,
    ]) {
      expect(await (await nitroApp.fetch(new Request(url))).json()).toEqual({ ...published, url })
    }
    // A POST with the parameter and a forged form is no frame: without a token it gets 403.
    const forged = await nitroApp.fetch(new Request(`https://site.test/page?${contentPreviewPublishedParameter}&${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ [contentPreviewFrameParameter]: JSON.stringify({ token: "v1.1.x", document: { collection: "posts", id: "b", data: { title: "Forged" } } }) }),
    }))
    expect(forged.status).toBe(403)
  })

  it("reads published on Nitro 2 with the cookie, isolated from preview requests of the same cookie", async () => {
    const { content, posts, cookie } = await publishedSite()
    const nitroApp = {
      h3App: {
        async handler(event: { node: { req: { url: string, headers: Record<string, string> }, res: ServerResponseLike } }) {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 5))
          const nested = await content.preview.run(event, async () => (await posts.get("b"))?.data.title)
          event.node.res.body = { url: event.node.req.url, active: content.preview.active(), a: (await posts.get("a"))?.data.title, nested }
        },
      },
      hooks: { hook: () => undefined },
    }
    defineContentPreviewPlugin(content)(nitroApp)
    const results = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const url = index % 2 === 0 ? `/page?${contentPreviewPublishedParameter}` : "/page"
      const event = { node: { req: { url, headers: { host: "site.test", cookie } }, res: serverResponse() } }
      await nitroApp.h3App.handler(event)
      return { body: event.node.res.body, cacheControl: event.node.res.headers["cache-control"], url }
    }))
    for (const result of results) {
      expect(result.cacheControl).toBe("private, no-store")
      expect(result.body).toEqual(result.url === "/page"
        ? { url: "/page", active: true, a: "A draft", nested: "B draft" }
        : { url: result.url, active: false, a: "A published", nested: "B published" })
    }
  })
})
