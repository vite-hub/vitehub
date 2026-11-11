import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { H3 } from "h3"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { documents } from "../src/collections.ts"
import { contentHead, contentSource, seo, defineContent, defineContentRssHandler, registerContentKV, renderContentRss } from "../src/index.ts"
import { historyWorkspace } from "./history-workspace.ts"

import type { MockInstance } from "vitest"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let warn: MockInstance<typeof console.warn>

const page = (title: string, extra = "") => `---\ntitle: ${title}\n${extra}---\nBody\n`
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-rss-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  warn.mockRestore()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** Tag names of a document in order, or an error when tags do not nest or an `&` starts no entity. */
function wellFormed(xml: string): string[] {
  const body = xml.replace(/^<\?xml[^>]*\?>\n/, "")
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(body)) throw new Error("A bare & in the XML.")
  const stack: string[] = []
  const names: string[] = []
  for (const [, close, name, , selfClosing] of body.matchAll(/<(\/?)([\w:]+)((?:\s+[\w:]+="[^"<]*")*)\s*(\/?)>/g)) {
    if (close) {
      if (stack.pop() !== name) throw new Error(`</${name}> closes another element.`)
    }
    else {
      names.push(name!)
      if (!selfClosing) stack.push(name!)
    }
  }
  if (stack.length) throw new Error(`<${stack.at(-1)}> is not closed.`)
  // Text between tags holds no markup.
  if (/[<>]/.test(body.replace(/<\/?[\w:]+(?:\s+[\w:]+="[^"<]*")*\s*\/?>/g, ""))) throw new Error("Markup in text.")
  return names
}

const itemLinks = (xml: string) => [...xml.matchAll(/<item>\s*<title>[^<]*<\/title>\s*<link>([^<]+)<\/link>/g)].map(match => match[1])
const commitLists = () => fake.requests.filter(request => request.path === "/repos/acme/docs/commits")
const fileHistories = () => fake.requests.filter(request => request.operation === "FileHistory")
const compares = () => fake.requests.filter(request => request.path.startsWith("/repos/acme/docs/compare/"))

function sourceSite(seo: Record<string, unknown> = { rss: true }) {
  const content = defineContent({
    route: false,
    logger: false,
    sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main", root: "content" }), { url: "/docs/:id" }) },
    seo: { site: "https://example.com", sitemap: true, ...seo },
  })
  cleanup.push(() => content.dispose())
  return content
}

describe("seo.rss for github() Sources", () => {
  it("orders pages by their latest commit and caches the dates per head commit", async () => {
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B"), "content/c.md": page("C") }, { author: { date: at(1), name: "Ada" } })
    fake.commit("main", { "content/a.md": page("A v2") }, { author: { date: at(3), name: "Ada" } })
    fake.commit("main", { "content/c.md": page("C v2") }, { author: { date: at(2), name: "Ada" } })
    const content = sourceSite()

    const xml = await content.rss()
    wellFormed(xml)
    expect(itemLinks(xml)).toEqual(["https://example.com/docs/a", "https://example.com/docs/c", "https://example.com/docs/b"])
    expect(xml).toContain(`<pubDate>${new Date(at(3)).toUTCString()}</pubDate>`)
    expect(xml).toContain(`<lastBuildDate>${new Date(at(3)).toUTCString()}</lastBuildDate>`)
    expect(xml).toContain(`<guid isPermaLink="true">https://example.com/docs/a</guid>`)
    expect(xml).toContain(`<title>example.com</title>`)
    expect(fileHistories()).toHaveLength(1)

    // The sitemap reads the same cached dates.
    expect(await content.sitemap()).toEqual([
      { collection: "docs", id: "a", loc: "https://example.com/docs/a", lastmod: at(3) },
      { collection: "docs", id: "b", loc: "https://example.com/docs/b", lastmod: at(1) },
      { collection: "docs", id: "c", loc: "https://example.com/docs/c", lastmod: at(2) },
    ])
    expect(await content.rss()).toBe(xml)
    expect(fileHistories()).toHaveLength(1)
    // Another server instance reads the dates from KV.
    expect(await sourceSite().rss()).toBe(xml)
    expect(fileHistories()).toHaveLength(1)

    // A new head asks GitHub for the changed page only.
    fake.commit("main", { "content/b.md": page("B v2") }, { author: { date: at(4), name: "Ada" } })
    await content.sources.advance("docs")
    const before = compares().length
    expect(itemLinks(await content.rss())[0]).toBe("https://example.com/docs/b")
    expect(compares().length - before).toBe(1)
    expect(fileHistories()).toHaveLength(2)
    expect(fileHistories()[1]!.body?.variables).toMatchObject({ p0: "content/b.md" })
    expect(fileHistories()[1]!.body?.variables).not.toHaveProperty("p1")
    expect(commitLists()).toHaveLength(0)
  })

  it("dates 2,600 pages with 18 GitHub GraphQL requests, then 2 requests after a push", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 2600; index++) files[`content/p${index}.md`] = page(`P${index}`)
    fake.commit("main", files, { author: { date: at(1), name: "Ada" } })
    fake.commit("main", { "content/p7.md": page("P7 v2") }, { author: { date: at(2), name: "Ada" } })
    const content = sourceSite()
    // Read the head and the commit first, so the counts below are the dates only.
    await content.list("docs")
    const start = fake.requests.length

    const xml = await content.rss()
    expect(itemLinks(xml)[0]).toBe("https://example.com/docs/p7")
    expect(xml.match(/<pubDate>/g)).toHaveLength(20)
    const cold = fake.requests.slice(start)
    expect(cold.filter(request => request.operation === "FileHistory")).toHaveLength(18)
    expect(cold).toHaveLength(18)
    expect((await content.sitemap()).filter(entry => entry.lastmod)).toHaveLength(2600)
    expect(fake.requests).toHaveLength(start + 18)

    // A push that changes 2 pages: 1 compare and 1 GraphQL request, on top of the head move.
    fake.commit("main", { "content/p1.md": page("P1 v2"), "content/p2.md": page("P2 v2"), "content/p2599.md": null }, { author: { date: at(3), name: "Ada" } })
    await content.sources.advance("docs")
    await content.list("docs")
    const moved = fake.requests.length
    const dated = await content.sitemap()
    expect(dated).toHaveLength(2599)
    expect(dated.find(entry => entry.id === "p1")?.lastmod).toBe(at(3))
    expect(dated.find(entry => entry.id === "p7")?.lastmod).toBe(at(2))
    expect(dated.find(entry => entry.id === "p100")?.lastmod).toBe(at(1))
    const warm = fake.requests.slice(moved)
    expect(warm.map(request => request.operation ?? request.path.replace(/\/compare\/.*/, "/compare"))).toEqual(["/repos/acme/docs/compare", "FileHistory"])
  }, 60_000)

  it("asks again with half the pages when GitHub stops a GraphQL request", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 150; index++) files[`content/p${index}.md`] = page(`P${index}`)
    fake.commit("main", files, { author: { date: at(1), name: "Ada" } })
    // GitHub answers 502 when a GraphQL request runs past 10 seconds.
    fake.respond(request => request.operation === "FileHistory" && Object.keys(Object(request.body?.variables)).length > 100
      ? new Response(JSON.stringify({ message: "We couldn't respond to your request in time." }), { status: 502 })
      : undefined)
    const content = sourceSite()

    expect((await content.sitemap()).filter(entry => entry.lastmod)).toHaveLength(150)
    expect(fileHistories().map(request => Object.keys(Object(request.body?.variables)).filter(name => /^p\d+$/.test(name)).length)).toEqual([150, 75, 75])
  })

  it("is a valid feed without a token, dated by the date field", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B", "date: 2026-09-01\n") })
    const content = sourceSite({ rss: { title: "Docs", limit: 5 } })

    const xml = await content.rss()
    wellFormed(xml)
    expect(itemLinks(xml)).toEqual(["https://example.com/docs/b", "https://example.com/docs/a"])
    expect(xml).toContain(`<pubDate>${new Date("2026-09-01").toUTCString()}</pubDate>`)
    expect(xml.match(/<pubDate>/g)).toHaveLength(1)
    expect(fileHistories()).toHaveLength(0)
    expect((await content.sitemap()).map(entry => entry.lastmod)).toEqual([undefined, undefined])
  })
})

describe("seo.rss for collections", () => {
  async function site(rss: unknown = true) {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      logger: false,
      collections: {
        posts: documents({ path: "posts/*.md", url: "/blog/:id", fields: { title: z.string(), description: z.string().optional(), seo: seo() } }),
        data: documents({ path: "data/*.json", url: "/data/:id", fields: { title: z.string() } }),
      },
      // SAFETY: Some tests pass an invalid option on purpose.
      seo: { site: "https://example.com", rss } as never,
    })
    cleanup.push(() => content.dispose())
    return content
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 5))

  it("lists published Markdown pages only, newest first by their latest published revision", async () => {
    const content = await site()
    const posts = content.collection("posts")
    await posts.save("old", { data: { title: "Old" }, body: "One\n" })
    await posts.save("new", { data: { title: "Fish & <chips> \"quoted\" 'single'", description: "A <b>bold</b> & brave post" }, body: "Two\n" })
    await posts.save("hidden", { data: { title: "Hidden", seo: { noindex: true } }, body: "Three\n" })
    await posts.save("draft", { data: { title: "Draft" }, body: "Four\n" })
    await content.collection("data").save("numbers", { data: { title: "Numbers" } })
    await content.publish({ collection: "posts", ids: ["old", "new", "hidden"] })
    await content.publish({ collection: "data" })
    await tick()
    await posts.save("old", { data: { title: "Old v2" }, body: "One v2\n" })
    await content.publish({ collection: "posts", ids: ["old"] })
    // A draft change after the publish does not move the date.
    await tick()
    await posts.save("new", { data: { title: "Draft title" }, body: "Two v2\n" })

    const xml = await content.rss()
    const names = wellFormed(xml)
    expect(names.filter(name => name === "item")).toHaveLength(2)
    expect(itemLinks(xml)).toEqual(["https://example.com/blog/old", "https://example.com/blog/new"])
    expect(xml).toContain("<title>Fish &amp; &lt;chips&gt; &quot;quoted&quot; &apos;single&apos;</title>")
    expect(xml).toContain("<description>A &lt;b&gt;bold&lt;/b&gt; &amp; brave post</description>")
    expect(xml).not.toContain("Draft")
    for (const path of ["/blog/old", "/blog/new"]) {
      const [latest] = (await content.history(path))!.entries
      expect(xml).toContain(`<link>https://example.com${path}</link>\n      ${path === "/blog/new" ? "<description>A &lt;b&gt;bold&lt;/b&gt; &amp; brave post</description>\n      " : ""}<guid isPermaLink="true">https://example.com${path}</guid>\n      <pubDate>${new Date(latest!.at).toUTCString()}</pubDate>`)
    }
  })

  it("keeps limit items and serves /rss.xml from the request origin", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, logger: false, collections: { posts: documents({ path: "posts/*.md", url: "/blog/:id", fields: { title: z.string() } }) }, seo: { rss: { limit: 1, description: "News" } } })
    cleanup.push(() => content.dispose())
    await content.collection("posts").save("a", { data: { title: "A" }, body: "A\n" })
    await content.publish({ collection: "posts" })
    await tick()
    await content.collection("posts").save("b", { data: { title: "B" }, body: "B\n" })
    await content.publish({ collection: "posts" })

    const response = await new H3().get("/rss.xml", defineContentRssHandler(content)).request("https://shop.test/rss.xml")
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8")
    const xml = await response.text()
    expect(itemLinks(xml)).toEqual(["https://shop.test/blog/b"])
    expect(xml).toContain("<description>News</description>")
    expect(xml).toContain(`<atom:link href="https://shop.test/rss.xml" rel="self" type="application/rss+xml"/>`)
  })

  it("answers 404 when rss is off and rejects invalid options", async () => {
    const content = await site(false)
    expect((await defineContentRssHandler(content).fetch(new Request("https://example.com/rss.xml"))).status).toBe(404)
    await expect(site({ limit: 0 })).rejects.toMatchObject({ code: "CONTENT_R0006" })
    await expect(site("yes")).rejects.toMatchObject({ code: "CONTENT_R0006" })
  })
})

describe("renderContentRss() and contentHead({ rss })", () => {
  it("renders an empty channel and links the feed", () => {
    const xml = renderContentRss({ title: "A & B", link: "https://example.com/", description: "D", self: "https://example.com/rss.xml" }, [])
    expect(wellFormed(xml)).toEqual(["rss", "channel", "title", "link", "description", "atom:link"])
    expect(contentHead({ data: { title: "Hi" } }, { site: { url: "https://example.com", name: "Example" }, rss: true }).link).toContainEqual(
      { rel: "alternate", type: "application/rss+xml", href: "https://example.com/rss.xml", title: "Example" },
    )
    expect(contentHead({ data: {} }, { rss: { href: "/feed.xml", title: "Feed" } }).link).toEqual([{ rel: "alternate", type: "application/rss+xml", href: "/feed.xml", title: "Feed" }])
  })
})
