import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { z } from "zod"

import { setServedBlobRoute } from "@vite-hub/blob/served"
import { createBlobDatabaseWorkspaceStore, workspaceHistorySchema } from "@vite-hub/workspace/blob-database"
import { registerWorkspace } from "@vite-hub/workspace/test"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { image } from "../../blob/src/reference.ts"
import { contentHead as clientContentHead } from "../src/client.ts"
import { createContentConsoleActions } from "../src/runtime/console.ts"
import {
  contentHead,
  defineContent,
  defineContentRobotsHandler,
  defineContentSitemapHandler,
  documents,
  renderContentSitemap,
  seo,
  singleton,
} from "../src/index.ts"

import type { ContentSeo, DefineContentSeoOptions } from "../src/index.ts"

const migration = await readFile(new URL("../../workspace/test/fixtures/history.sql", import.meta.url), "utf8")
const cleanup: Array<() => Promise<void> | void> = []
let workspaces = 0

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-seo-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createClient({ url: `file:${join(root, "history.sqlite")}` })
  cleanup.push(() => client.close())
  const database = drizzle(client, { schema: workspaceHistorySchema })
  for (const statement of migration.split(";").filter(statement => statement.trim())) await database.run(sql.raw(statement))
  const blob = createBlobStorage(createDriver({ driver: "fs", base: join(root, "objects") }))
  const name = `seo-${++workspaces}`
  registerWorkspace(name, { store: createBlobDatabaseWorkspaceStore({ blob, database, workspace: name }) })
  return name
}

async function validate(schema: { "~standard": { validate: (value: unknown) => unknown } }, value: unknown): Promise<any> {
  return await schema["~standard"].validate(value)
}

describe("seo()", () => {
  it("validates per-document SEO and keeps the whole field optional", async () => {
    const field = seo()
    expect(await validate(field, undefined)).toEqual({ value: undefined })
    expect(await validate(field, { title: "Hello", description: "", image: "/og/hello.png", canonical: "https://example.com/hello", noindex: false })).toEqual({
      value: { title: "Hello", image: "/og/hello.png", canonical: "https://example.com/hello" },
    })
    expect(await validate(field, { title: 1, image: "og.png", canonical: "//evil.test", noindex: "yes", keywords: [] })).toEqual({
      issues: [
        expect.objectContaining({ path: ["keywords"] }),
        expect.objectContaining({ path: ["title"] }),
        expect.objectContaining({ path: ["canonical"] }),
        expect.objectContaining({ path: ["noindex"] }),
        expect.objectContaining({ path: ["image"], message: expect.stringContaining("absolute URL") }),
      ],
    })
    // Long values are guidance, not errors.
    expect(await validate(field, { title: "x".repeat(200) })).toEqual({ value: { title: "x".repeat(200) } })
  })

  it("holds a Blob image() and reports its issues under image", async () => {
    const field = seo({ image: image() })
    const cover = { pathname: "og/hello.png", contentType: "image/png", size: 1024 }
    expect(await validate(field, { image: cover })).toEqual({ value: { image: cover } })
    expect(await validate(field, { image: { pathname: "doc.pdf", contentType: "application/pdf" } })).toMatchObject({
      issues: [{ path: ["image", "contentType"] }],
    })
    expectTypeOf<NonNullable<typeof field["~standard"]["types"]>["output"]>().toEqualTypeOf<ContentSeo<{ pathname: string, contentType?: string, size?: number }> | undefined>()
  })

  it("projects a JSON Schema with length hints and the nested image", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: { posts: documents({ path: "posts/*.md", fields: { title: z.string(), seo: seo({ image: image({ store: "media" }) }) } }) },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    expect(posts.seo).toBe("seo")
    expect(posts.schema).toMatchObject({
      required: ["title"],
      properties: {
        seo: {
          type: "object",
          additionalProperties: false,
          "x-vitehub-seo": { title: { recommended: 60 }, description: { min: 50, recommended: 160 } },
          properties: {
            title: { type: "string" },
            image: { type: "object", "x-vitehub-blob": { kind: "image", store: "media" } },
            noindex: { type: "boolean" },
          },
        },
      },
    })
    // Stored SEO round-trips through YAML frontmatter as a nested block.
    const saved = await posts.save("hello", { data: { title: "Hello", seo: { title: "Hello, SEO", image: { pathname: "og/hello.png", contentType: "image/png" } } } })
    expect(saved.data.seo).toEqual({ title: "Hello, SEO", image: { pathname: "og/hello.png", contentType: "image/png" } })
    expect((await posts.raw("hello", { ref: "draft" }))?.text).toBe("---\ntitle: Hello\nseo:\n  title: Hello, SEO\n  image:\n    pathname: og/hello.png\n    contentType: image/png\n---\n")
    expectTypeOf(saved.data.seo).toEqualTypeOf<ContentSeo<{ pathname: string, contentType?: string, size?: number }> | undefined>()
    await expect(posts.save("bad", { data: { title: "Bad", seo: { image: { pathname: "/abs.png", contentType: "image/png" } } } })).resolves.toMatchObject({
      issues: [{ field: "seo", path: ["image", "pathname"] }],
    })
  })
})

describe("document urls", () => {
  it("maps documents to public URLs with a pattern or a function", async () => {
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: {
        posts: documents({ path: "posts/**/*.md", fields: { title: z.string(), category: z.string().optional() }, url: "/blog/:category/:id" }),
        pages: documents({ path: "pages/*.md", fields: { title: z.string() }, url: ({ id }) => id === "index" ? "/" : `/${id}` }),
        home: singleton({ path: "home.md", fields: { title: z.string() }, url: "/" }),
        notes: documents({ path: "notes/*.md", fields: { title: z.string() } }),
      },
      logger: false,
    })
    cleanup.push(() => content.dispose())
    expect(await content.collection("posts").save("2026/hello world", { data: { title: "Hi", category: "news" } })).toMatchObject({ url: "/blog/news/2026/hello%20world" })
    expect(await content.collection("posts").save("draft", { data: { title: "No category" } })).toMatchObject({ url: null })
    expect(await content.collection("pages").save("index", { data: { title: "Home" } })).toMatchObject({ url: "/" })
    expect(await content.collection("home").save({ data: { title: "Home" } })).toMatchObject({ url: "/" })
    expect(await content.collection("notes").save("a", { data: { title: "A" } })).not.toHaveProperty("url")
    expect((await content.collection("posts").list({ ref: "draft" })).items.map(item => item.url)).toEqual(["/blog/news/2026/hello%20world", null])
    expect(content.collections().map(collection => [collection.name, collection.routable])).toEqual([["posts", true], ["pages", true], ["home", true], ["notes", false]])
    // The Console editor gets the URL for canonical placeholders and previews.
    const actions = createContentConsoleActions({ content: { ...content, can: async () => true } })
    expect(await actions.get({ collection: "home", id: "home" }, { user: null })).toMatchObject({ url: "/" })
    expect(await actions.get({ collection: "notes", id: "a" }, { user: null })).not.toHaveProperty("url")
  })

  it("rejects patterns that name unknown fields", () => {
    expect(() => documents({ path: "posts/*.md", fields: {}, url: "/blog/:slug" })).toThrow(/:slug, which is neither :id nor a field/)
    expect(() => documents({ path: "posts/*.md", fields: {}, url: "blog/:id" })).toThrow(/starts with \//)
  })
})

describe("contentHead()", () => {
  const site = { url: "https://vitehub.dev", name: "ViteHub", locale: "en_US" }
  const defaults = { title: "ViteHub", description: "Server primitives for any host.", image: { pathname: "og/default.png" } }

  it("merges per-document SEO, document fields, and site defaults", () => {
    const post = { url: "/blog/hello", updatedAt: "2026-10-14T00:00:00.000Z", data: { title: "Hello", summary: "A first post.", seo: { title: "Hello, world", image: "/og/hello.png" } } }
    expect(contentHead(post, { site, defaults })).toEqual({
      title: "Hello, world · ViteHub",
      meta: [
        { name: "description", content: "A first post." },
        { property: "og:title", content: "Hello, world" },
        { property: "og:description", content: "A first post." },
        { property: "og:type", content: "article" },
        { property: "og:url", content: "https://vitehub.dev/blog/hello" },
        { property: "og:image", content: "https://vitehub.dev/og/hello.png" },
        { property: "og:site_name", content: "ViteHub" },
        { property: "og:locale", content: "en_US" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: "Hello, world" },
        { name: "twitter:description", content: "A first post." },
        { name: "twitter:image", content: "https://vitehub.dev/og/hello.png" },
      ],
      link: [{ rel: "canonical", href: "https://vitehub.dev/blog/hello" }],
    })
  })

  it("falls back to defaults, honors canonical and noindex, and renders JSON-LD safely", () => {
    const head = contentHead({ data: { title: "</script><script>alert(1)</script>", seo: { canonical: "/original", noindex: true } } }, { site, defaults, titleTemplate: "%s | Docs", jsonLd: true })
    expect(head.title).toBe("</script><script>alert(1)</script> | Docs")
    expect(head.meta).toContainEqual({ name: "robots", content: "noindex" })
    expect(head.meta).toContainEqual({ name: "description", content: "Server primitives for any host." })
    expect(head.link).toEqual([{ rel: "canonical", href: "https://vitehub.dev/original" }])
    expect(head.script?.[0]?.innerHTML).not.toContain("</script>")
    expect(JSON.parse(head.script![0]!.innerHTML)).toMatchObject({ "@type": "WebPage", name: "</script><script>alert(1)</script>", url: "https://vitehub.dev/original" })
    // Without a document title, the site title is used as is.
    expect(contentHead(null, { site, defaults }).title).toBe("ViteHub")
    expect(contentHead({ data: { title: "Docs" } }, { titleTemplate: null }).title).toBe("Docs")
    expect(contentHead({ data: { seo: { image: { pathname: "x.png" } } } }, { resolveImage: value => `https://cdn.test/${(value as { pathname: string }).pathname}` }).meta).toContainEqual({ property: "og:image", content: "https://cdn.test/x.png" })
  })

  it("serves Blob images from the route of the generated Blob config, and only from it", () => {
    const blobImage = { data: { seo: { image: { pathname: "og/a b.png" } } } }
    const ogImage = (options: Parameters<typeof contentHead>[1] = {}) => contentHead(blobImage, options).meta.find(tag => tag.property === "og:image")?.content
    cleanup.push(() => setServedBlobRoute(undefined))
    // Without a loaded Blob config, as in the browser, a Blob reference has no URL to guess.
    setServedBlobRoute(undefined)
    expect(ogImage()).toBeUndefined()
    setServedBlobRoute({ route: "/api/_vitehub/blob", store: "default" })
    expect(ogImage({ site })).toBe("https://vitehub.dev/api/_vitehub/blob/og/a%20b.png")
    setServedBlobRoute({ route: "/assets/", store: "default", publicBaseUrl: "https://cdn.vitehub.dev/" })
    expect(ogImage()).toBe("https://cdn.vitehub.dev/assets/og/a%20b.png")
    // `blob.serve` serves one store; references of the `default` store have no URL when another one is served.
    setServedBlobRoute({ route: "/media", store: "media" })
    expect(ogImage()).toBeUndefined()
  })

  it("finds the seo() field by its marker and names the page with the title field", async () => {
    const post = { data: { headline: "Launch", meta: { title: "Launch day", description: "Everything that shipped." } } }
    // Without the collection, a field not named `seo` is not SEO.
    expect(contentHead(post).title).toBeUndefined()
    const collection = { seo: "meta", titleField: "headline" }
    expect(contentHead(post, { collection })).toMatchObject({ title: "Launch day", meta: expect.arrayContaining([{ name: "description", content: "Everything that shipped." }]) })
    expect(contentHead({ data: { headline: "Launch" } }, { collection }).title).toBe("Launch")
    // The JSON form of a collection, such as one sent to the browser, carries the marker in its schema.
    const workspace = await historyWorkspace()
    const content = defineContent({ workspace, collections: { posts: documents({ path: "posts/*.md", titleField: "headline", fields: { headline: z.string(), meta: seo() } }) }, logger: false })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    expect(posts).toMatchObject({ seo: "meta", titleField: "headline" })
    expect(contentHead(post, { collection: posts }).title).toBe("Launch day")
    expect(contentHead(post, { collection: JSON.parse(JSON.stringify({ schema: posts.schema })) }).title).toBe("Launch day")
    // `field` still names the field outright.
    expect(contentHead({ data: { social: { title: "Social" } } }, { collection, field: "social" }).title).toBe("Social")
  })

  it("is available from the client entry without the server runtime", () => {
    expect(clientContentHead).toBe(contentHead)
  })
})

describe("sitemap and robots", { timeout: 30_000 }, () => {
  async function site(seoOptions: DefineContentSeoOptions = { site: "https://example.com", sitemap: true, robots: true }) {
    const workspace = await historyWorkspace()
    const content = defineContent({
      workspace,
      collections: {
        settings: singleton({ path: "settings.json", fields: { title: z.string() } }),
        home: singleton({ path: "home.md", fields: { title: z.string() }, url: "/" }),
        posts: documents({ path: "posts/*.md", fields: { title: z.string(), seo: seo() }, url: "/blog/:id" }),
      },
      seo: seoOptions,
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const posts = content.collection("posts")
    await content.collection("settings").save({ data: { title: "Site" } })
    await content.collection("home").save({ data: { title: "Home" } })
    await posts.save("hello", { data: { title: "Hello" } })
    await posts.save("hidden", { data: { title: "Hidden", seo: { noindex: true } } })
    await posts.save("copy", { data: { title: "Copy", seo: { canonical: "/blog/hello" } } })
    await posts.save("self", { data: { title: "Self", seo: { canonical: "https://example.com/blog/self" } } })
    await posts.save("<draft&>", { data: { title: "Unpublished" } })
    await content.publish({ ids: ["hello", "hidden", "copy", "self"], collection: "posts" })
    await content.publish({ collection: "home" })
    return content
  }

  it("lists published, indexable documents with a URL and their last change", async () => {
    const content = await site()
    const entries = await content.sitemap()
    expect(entries).toEqual([
      { collection: "home", id: "home", loc: "https://example.com/", lastmod: expect.stringMatching(/^\d{4}-/) },
      { collection: "posts", id: "hello", loc: "https://example.com/blog/hello", lastmod: expect.any(String) },
      { collection: "posts", id: "self", loc: "https://example.com/blog/self", lastmod: expect.any(String) },
    ])
    expect(renderContentSitemap([{ collection: "posts", id: "x", loc: "https://example.com/a?b=1&c=<2>" }])).toBe(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  <url>\n    <loc>https://example.com/a?b=1&amp;c=&lt;2&gt;</loc>\n  </url>\n</urlset>\n",
    )
    expect(content.robots()).toBe("User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n")
  })

  it("serves /sitemap.xml and /robots.txt from the request origin without a site", async () => {
    const content = await site({ sitemap: true, robots: { disallow: ["/admin", "/_vitehub"] } })
    const app = new H3().get("/sitemap.xml", defineContentSitemapHandler(content)).get("/robots.txt", defineContentRobotsHandler(content))
    const sitemap = await app.request("https://shop.test/sitemap.xml")
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8")
    const xml = await sitemap.text()
    expect(xml).toContain("<loc>https://shop.test/blog/hello</loc>")
    expect(xml).not.toContain("hidden")
    expect(xml).not.toContain("draft")
    expect(await (await app.request("https://shop.test/robots.txt")).text()).toBe("User-agent: *\nDisallow: /admin\nDisallow: /_vitehub\n\nSitemap: https://shop.test/sitemap.xml\n")
  })

  it("answers 404 for routes that seo does not turn on and rejects invalid options", async () => {
    const content = await site({ site: "https://example.com" })
    const app = new H3().get("/sitemap.xml", defineContentSitemapHandler(content)).get("/robots.txt", defineContentRobotsHandler(content))
    expect((await app.request("/sitemap.xml")).status).toBe(404)
    expect((await app.request("/robots.txt")).status).toBe(404)
    expect(() => defineContent({ source: { async items() { return [] } }, seo: { site: "example.com" } })).toThrow(/absolute http\(s\) URL/)
    // Disallowed paths start with /.
    expect(() => defineContent({ source: { async items() { return [] } }, seo: { robots: { disallow: ["admin"] } } })).toThrow(/disallow/)
  })
})
