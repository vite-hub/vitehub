import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
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
import { contentPreviewCookieName, contentPreviewFrameParameter, contentPreviewPublishedParameter, contentRefTokenParameter, defineContent, defineContentHandler, defineContentPreviewPlugin } from "../src/index.ts"

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
  const database = drizzle({ client: client })
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

function contentApp(content: Awaited<ReturnType<typeof setup>>["content"]) {
  return new H3().all("/api/content/**", defineContentHandler(content))
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

  it("keeps a request with a signed ref link out of Nitro's cache", async () => {
    const { content } = await setup()
    const app = new H3().get("/preview/feat", (event) => {
      event.res.headers.set("cache-control", "public, max-age=3600, s-maxage=3600")
      return { bypass: shouldBypassCache() }
    })
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)

    const signed = await nitroApp.fetch(new Request(`https://site.test/preview/feat?${contentRefTokenParameter}=v1.0.x.y`))
    expect(await signed.json()).toEqual({ bypass: true })
    expect(signed.headers.get("cache-control")).toBe("private, no-store")
    const plain = await nitroApp.fetch(new Request("https://site.test/preview/feat"))
    expect(await plain.json()).toEqual({ bypass: false })
    expect(plain.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=3600")
    expect(shouldBypassCache()).toBe(false)
  })

  it("loads the Content runtime on the first preview request when the plugin gets a loader", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const app = new H3().get("/blog/hello", async () => ({ bypass: shouldBypassCache(), title: (await posts.get("hello"))?.data.title }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    const load = vi.fn(async () => content)
    defineContentPreviewPlugin(load)(nitroApp)

    // The generated plugin passes a loader, so a server without preview requests never loads server/content.ts.
    expect(await (await nitroApp.fetch(new Request("https://site.test/blog/hello"))).json()).toEqual({ bypass: false, title: "Published" })
    expect(shouldBypassCache()).toBe(false)
    expect(load).not.toHaveBeenCalled()

    const previews = await Promise.all([1, 2].map(async () => await nitroApp.fetch(new Request("https://site.test/blog/hello", { headers: { cookie } }))))
    for (const preview of previews) {
      expect(await preview.json()).toEqual({ bypass: true, title: "Draft" })
      expect(preview.headers.get("cache-control")).toBe("private, no-store")
    }
    const published = await nitroApp.fetch(new Request(`https://site.test/blog/hello?${contentPreviewPublishedParameter}`, { headers: { cookie } }))
    expect(await published.json()).toEqual({ bypass: true, title: "Published" })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("retries a Content runtime loader that failed", async () => {
    const { content } = await setup()
    const cookie = await previewCookie(content)
    const nitroApp = { fetch: (_request: Request) => new Response("page") }
    const load = vi.fn<() => Promise<typeof content>>()
      .mockRejectedValueOnce(new Error("server/content.ts failed"))
      .mockResolvedValue(content)
    defineContentPreviewPlugin(load)(nitroApp)

    const request = () => nitroApp.fetch(new Request("https://site.test/", { headers: { cookie } }))
    await expect(request()).rejects.toThrow("server/content.ts failed")
    expect(await (await request()).text()).toBe("page")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("rejects apps without Nitro 3's fetch entry for eager and lazy Content runtimes", async () => {
    const { content } = await setup()
    const load = vi.fn(async () => content)
    const handler = vi.fn()
    const nitroApp = { h3App: { handler } }

    for (const host of [content, load]) {
      expect(() => defineContentPreviewPlugin(host)(nitroApp)).toThrow(expect.objectContaining({ code: "CONTENT_R0008" }))
    }
    expect(load).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
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

  it("answers a same-origin redirect of a Nitro 3 preview frame with a 307 that posts the same form to the next page", async () => {
    const { content, posts } = await setup()
    const seen: Array<{ url: string, method: string, cookie: string | null, type: string | null, frame?: string }> = []
    const app = new H3()
      .use((event) => {
        seen.push({ url: event.req.url, method: event.req.method, cookie: event.req.headers.get("cookie"), type: event.req.headers.get("content-type"), frame: content.preview.frame()?.id })
      })
      .get("/blog/old", () => Response.redirect("https://site.test/en/blog/hello", 301))
      .get("/en/blog/hello", () => {
        const headers = new Headers({ location: "../../blog/hello?q=a%20b&flag#top" })
        headers.append("set-cookie", "session=abc; Path=/; HttpOnly")
        headers.append("set-cookie", "__Host-id=1; Secure; Path=/")
        headers.append("set-cookie", "admin=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        headers.set("content-type", "text/plain")
        return new Response("moved", { status: 302, headers })
      })
      .get("/blog/hello", async () => ({ get: (await posts.get("hello"))?.data.title }))
      .get("/blog/away", () => Response.redirect("https://other.test/blog/hello", 302))
      .get("/blog/http", () => Response.redirect("http://site.test/blog/hello", 302))
      .get("/blog/port", () => Response.redirect("https://site.test:8443/blog/hello", 302))
      .get("/blog/slashes", () => new Response(null, { status: 302, headers: { location: "//other.test/blog/hello" } }))
      .get("/blog/script", () => new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } }))
      .get("/blog/invalid", () => new Response(null, { status: 302, headers: { location: "https://[" } }))
      .get("/blog/loop", () => new Response(null, { status: 303, headers: { location: "/blog/loop" } }))
      .get("/blog/not-modified", () => new Response(null, { status: 304, headers: { location: "/blog/hello" } }))
    const nitroApp = { fetch: (request: Request) => app.fetch(request), h3: app }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    // A browser does not send the fragment.
    const frame = (url: string, headers: Record<string, string> = {}) => nitroApp.fetch(new Request(url.startsWith("/") ? `https://site.test${url}` : url.split("#", 1)[0]!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", origin: "https://site.test", cookie: "prefs=1", ...headers },
      body: frameForm(token),
    }))

    // A locale redirect: a 307 to its Location with the next hop. The page saw a GET with the browser's own cookies.
    const first = await frame(`/blog/old?${contentPreviewFrameParameter}`)
    expect(first.status).toBe(307)
    expect(first.headers.get("location")).toBe(`https://site.test/en/blog/hello?${contentPreviewFrameParameter}=1`)
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    expect(seen).toEqual([{ url: "https://site.test/blog/old", method: "GET", cookie: "prefs=1", type: null, frame: "hello" }])
    // A relative canonical redirect keeps its query as it is written and its fragment, and every Set-Cookie unchanged.
    const second = await frame(first.headers.get("location")!)
    expect(second.status).toBe(307)
    expect(second.headers.get("location")).toBe(`https://site.test/blog/hello?q=a%20b&flag&${contentPreviewFrameParameter}=2#top`)
    expect(second.headers.getSetCookie()).toEqual(["session=abc; Path=/; HttpOnly", "__Host-id=1; Secure; Path=/", "admin=; Path=/admin; Expires=Thu, 01 Jan 1970 00:00:00 GMT"])
    expect(await second.text()).toBe("")
    // The browser posts the form again: the last page renders the document on screen, with the query it was given.
    const last = await frame(second.headers.get("location")!, { cookie: "prefs=1; session=abc" })
    expect(last.status).toBe(200)
    expect(await last.json()).toEqual({ get: "On screen" })
    expect(seen.at(-1)).toEqual({ url: "https://site.test/blog/hello?q=a%20b&flag", method: "GET", cookie: "prefs=1; session=abc", type: null, frame: "hello" })
    // No URL of the chain holds the token or the document.
    for (const location of [first, second].map(response => response.headers.get("location")!)) {
      expect(location).not.toContain(token)
      expect(location).not.toContain("On%20screen")
    }

    // Another origin, scheme, or port, a scheme that is not HTTP, and a Location that is not valid get the error page.
    for (const [path, message] of [
      ["/blog/away", "https://other.test, which is another site"],
      ["/blog/http", "http://site.test, which is another site"],
      ["/blog/port", "https://site.test:8443, which is another site"],
      ["/blog/slashes", "https://other.test, which is another site"],
      ["/blog/script", "not valid"],
      ["/blog/invalid", "not valid"],
    ] as const) {
      const refused = await frame(`${path}?${contentPreviewFrameParameter}`)
      expect(refused.status).toBe(502)
      expect(refused.headers.get("location")).toBeNull()
      expect(refused.headers.get("cache-control")).toBe("private, no-store")
      expect(await refused.text()).toContain(message)
    }
    // X-Forwarded-Host is not this origin: the form never goes there.
    expect((await frame(`/blog/away?${contentPreviewFrameParameter}`, { "x-forwarded-host": "other.test" })).status).toBe(502)
    // A loop stops at the sixth redirect, whatever hop the browser comes with.
    const hops: number[] = []
    let next = `/blog/loop?${contentPreviewFrameParameter}`
    for (;;) {
      const response = await frame(next)
      hops.push(response.status)
      if (response.status !== 307) {
        expect(await response.text()).toContain("redirects more than 5 times")
        break
      }
      next = response.headers.get("location")!
    }
    expect(hops).toEqual([307, 307, 307, 307, 307, 502])
    // A status that a browser does not follow is not a redirect.
    expect((await frame(`/blog/not-modified?${contentPreviewFrameParameter}`)).status).toBe(304)

    // Outside a frame the same request keeps the ordinary redirect.
    const outside = await nitroApp.fetch(new Request("https://site.test/en/blog/hello", { headers: { cookie: "prefs=1" } }))
    expect(outside.status).toBe(302)
    expect(outside.headers.get("location")).toBe("../../blog/hello?q=a%20b&flag#top")
    expect(outside.headers.get("cache-control")).toBeNull()
  })

  it("passes a joined Set-Cookie of a frame redirect on a host without Headers.getSetCookie", async () => {
    const { content } = await setup()
    const render = vi.fn(async (_request: Request) => {
      const response = new Response(null, { status: 302, headers: { location: "/blog/hello", "set-cookie": "locale=en; Path=/" } })
      // Older Fetch hosts expose a combined Set-Cookie header without this newer method.
      Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
      return response
    })
    const nitroApp = { fetch: render }
    defineContentPreviewPlugin(content)(nitroApp)
    const { token } = await content.preview.sign({ collection: "posts", id: "hello" })
    const response = await nitroApp.fetch(new Request(`https://site.test/start?${contentPreviewFrameParameter}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://site.test" },
      body: frameForm(token),
    }))
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe(`https://site.test/blog/hello?${contentPreviewFrameParameter}=1`)
    expect(response.headers.get("set-cookie")).toBe("locale=en; Path=/")
    expect(render).toHaveBeenCalledOnce()
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
    const content = defineContent({ access: "public", source: { items: async () => [{ key: "index.md", content: "# Home" }] }, logger: false })
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
    // A percent-encoded parameter name still counts.
    expect(await titleOf(await api(`https://site.test/page?${encodeURIComponent(contentPreviewPublishedParameter).replaceAll("-", "%2D")}`))).toBe("B published")
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
})
