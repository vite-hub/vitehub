import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"
import { defineCollectionHandler } from "@vite-hub/source/server"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { contentPreviewCookieName, defineContent, defineContentHandler, defineContentPreviewMiddleware, documents } from "../src/index.ts"

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
async function previewCookie(content: Awaited<ReturnType<typeof setup>>["content"], options?: { maxAge?: number }) {
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

  it("scopes whole requests through the generated middleware", async () => {
    const { content, posts } = await setup()
    const cookie = await previewCookie(content)
    const run = vi.spyOn(content.preview, "run")
    const app = new H3()
      .use(defineContentPreviewMiddleware(content))
      .get("/blog/hello", async () => ({ title: (await posts.get("hello"))?.data.title }))
      .get("/posts", defineCollectionHandler(posts))

    const page = await app.request("/blog/hello")
    expect(await page.json()).toEqual({ title: "Published" })
    expect(page.headers.get("cache-control")).toBeNull()
    expect(run).not.toHaveBeenCalled()

    const preview = await app.request("/blog/hello", { headers: { cookie } })
    expect(await preview.json()).toEqual({ title: "Draft" })
    expect(preview.headers.get("cache-control")).toBe("private, no-store")
    expect(run).toHaveBeenCalledTimes(1)

    expect(await (await app.request("/posts", { headers: { cookie } })).json()).toMatchObject({ total: 2 })
    expect(await (await app.request("/posts")).json()).toMatchObject({ total: 1 })
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
