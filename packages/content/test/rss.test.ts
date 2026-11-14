import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { H3 } from "h3"
import { kv } from "@vite-hub/kv"
import { createMemoryLeaseStore } from "@vite-hub/runtime"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { documents } from "../src/collections.ts"
import { contentHead, contentSource, seo, defineContent, defineContentGitHubWebhookHandler, defineContentRssHandler, defineContentSitemapHandler, registerContentKV, renderContentRss } from "../src/index.ts"
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
    access: "public",
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

  it("dates a page that a later commit reverted by the revert, not by the net change", async () => {
    fake.commit("main", { "content/guide.md": page("Guide"), "content/other.md": page("Other") }, { author: { date: at(1), name: "Ada" } })
    const content = sourceSite()
    await content.sitemap()
    fake.commit("main", { "content/guide.md": page("Guide draft") }, { author: { date: at(2), name: "Ada" } })
    fake.commit("main", { "content/guide.md": page("Guide"), "content/other.md": page("Other v2") }, { author: { date: at(3), name: "Ada" } })
    await content.sources.advance("docs")
    await content.list("docs")
    const start = fake.requests.length

    expect(await content.sitemap()).toEqual([
      { collection: "docs", id: "guide", loc: "https://example.com/docs/guide", lastmod: at(3) },
      { collection: "docs", id: "other", loc: "https://example.com/docs/other", lastmod: at(3) },
    ])
    // One compare, the files of its 2 commits, and one GraphQL request for both pages.
    const requests = fake.requests.slice(start, start + 4).map(request => request.operation ?? request.path.replace(/\/(compare|commits)\/.*/, "/$1"))
    expect(requests).toEqual(["/repos/acme/docs/compare", "/repos/acme/docs/commits", "/repos/acme/docs/commits", "FileHistory"])
  })

  it("keeps serving the sitemap when GitHub fails to give the page dates", async () => {
    fake.commit("main", { "content/a.md": page("A") }, { author: { date: at(1), name: "Ada" } })
    let failing = true
    fake.respond(request => failing && request.operation === "FileHistory" ? new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }) : undefined)
    const content = sourceSite({ rss: false })
    await content.list("docs")

    const response = await defineContentSitemapHandler(content).fetch(new Request("https://example.com/sitemap.xml"))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("<loc>https://example.com/docs/a</loc>")
    expect(warn.mock.calls.some(([message]) => String(message).includes("could not read the page dates"))).toBe(true)

    // The failed dates are not kept, so the next request asks again.
    failing = false
    expect(await content.sitemap()).toEqual([{ collection: "docs", id: "a", loc: "https://example.com/docs/a", lastmod: at(1) }])
  })

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

describe("page dates after a head move", () => {
  /** Hold GitHub GraphQL requests until `open()`, and count the ones that wait. */
  function gateGraphQL() {
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const waiting = { count: 0 }
    vi.stubGlobal("fetch", vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/graphql")) {
        waiting.count++
        await gate
      }
      return await fake.fetch(input, init)
    }))
    return { open, waiting }
  }

  /** A request with `waitUntil`, as a Worker or Vercel gives it, and the work it collects. */
  function hostRequest(url: string) {
    const tasks: Promise<unknown>[] = []
    const request = new Request(url)
    Object.defineProperty(request, "waitUntil", { value: (task: Promise<unknown>) => tasks.push(task) })
    return { request, tasks }
  }

  it("answers a cold request at once and computes the dates after the response", async () => {
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B", "date: 2026-09-01\n") }, { author: { date: at(1), name: "Ada" } })
    fake.commit("main", { "content/a.md": page("A v2") }, { author: { date: at(3), name: "Ada" } })
    const content = sourceSite()
    await content.list("docs")
    const gate = gateGraphQL()
    const rss = defineContentRssHandler(content)

    const cold = hostRequest("https://example.com/rss.xml")
    const response = await rss.fetch(cold.request)
    // GitHub has not answered, so the request did not wait for it.
    expect(fileHistories()).toHaveLength(0)
    expect(cold.tasks).toHaveLength(1)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const xml = await response.text()
    wellFormed(xml)
    // No dates yet: b has its date field, a has none.
    expect(itemLinks(xml)).toEqual(["https://example.com/docs/b", "https://example.com/docs/a"])
    expect(xml.match(/<pubDate>/g)).toHaveLength(1)

    gate.open()
    await Promise.all(cold.tasks)
    expect(fileHistories()).toHaveLength(1)
    const warm = hostRequest("https://example.com/rss.xml")
    const next = await rss.fetch(warm.request)
    expect(warm.tasks).toHaveLength(0)
    expect(next.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate")
    expect(await next.text()).toContain(`<pubDate>${new Date(at(3)).toUTCString()}</pubDate>`)
    expect(fileHistories()).toHaveLength(1)
  })

  it("answers with the dates of the previous head until the new ones are ready", async () => {
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B") }, { author: { date: at(1), name: "Ada" } })
    fake.commit("main", { "content/b.md": page("B v2") }, { author: { date: at(2), name: "Ada" } })
    const content = sourceSite()
    await content.sitemap()
    fake.commit("main", { "content/a.md": page("A v2"), "content/c.md": page("C", "date: 2026-09-01\n") }, { author: { date: at(4), name: "Ada" } })
    await content.sources.advance("docs")
    await content.list("docs")
    const gate = gateGraphQL()
    const sitemap = defineContentSitemapHandler(content)

    const stale = hostRequest("https://example.com/sitemap.xml")
    const response = await sitemap.fetch(stale.request)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const xml = await response.text()
    expect(xml).toContain(`<loc>https://example.com/docs/a</loc>\n    <lastmod>${at(1)}</lastmod>`)
    expect(xml).toContain(`<loc>https://example.com/docs/b</loc>\n    <lastmod>${at(2)}</lastmod>`)
    // A new page has no lastmod until the dates of the new head are ready.
    expect(xml).toMatch(/<loc>https:\/\/example\.com\/docs\/c<\/loc>\n {2}<\/url>/)

    gate.open()
    await Promise.all(stale.tasks)
    expect(await content.sitemap()).toEqual([
      { collection: "docs", id: "a", loc: "https://example.com/docs/a", lastmod: at(4) },
      { collection: "docs", id: "b", loc: "https://example.com/docs/b", lastmod: at(2) },
      { collection: "docs", id: "c", loc: "https://example.com/docs/c", lastmod: at(4) },
    ])
  })

  it("uses an atomic lease when replicas start the same date set together", async () => {
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B") }, { author: { date: at(1), name: "Ada" } })
    const dateLeases = createMemoryLeaseStore()
    const first = sourceSite({ rss: true, dateLeases })
    const second = sourceSite({ rss: true, dateLeases })
    await first.list("docs")
    await second.list("docs")
    // Both replicas can miss an eventually consistent KV cache, even after another replica writes it.
    registerContentKV({
      get: <T>(key: string) => key.startsWith("content:dates:") ? Promise.resolve([undefined, undefined] as const) : kv.get<T>(key),
      set: (key, value) => kv.set(key, value),
    })
    const gate = gateGraphQL()

    const one = hostRequest("https://example.com/rss.xml")
    const two = hostRequest("https://example.com/rss.xml")
    await Promise.all([defineContentRssHandler(first).fetch(one.request), defineContentRssHandler(second).fetch(two.request)])
    expect(one.tasks).toHaveLength(1)
    expect(two.tasks).toHaveLength(1)

    gate.open()
    await Promise.all([...one.tasks, ...two.tasks])
    expect(gate.waiting.count).toBe(1)
    expect(fileHistories()).toHaveLength(1)
    // The second instance reads the set that the first one stored.
    registerContentKV(kv)
    expect(await second.rss()).toContain(`<pubDate>${new Date(at(1)).toUTCString()}</pubDate>`)
    expect(fileHistories()).toHaveLength(1)
  })

  it.each([true, false])("shares date work between background and blocking reads (background first: %s)", async (backgroundFirst) => {
    fake.commit("main", { "content/a.md": page("A") }, { author: { date: at(1), name: "Ada" } })
    const dateLeases = createMemoryLeaseStore()
    const acquire = vi.spyOn(dateLeases, "acquire")
    const content = sourceSite({ rss: true, dateLeases })
    await content.list("docs")
    const gate = gateGraphQL()
    const tasks: Promise<unknown>[] = []
    const background = () => content.rss({ waitUntil: task => tasks.push(task) })
    let blocking: Promise<string>
    if (backgroundFirst) {
      await background()
      await vi.waitFor(() => expect(gate.waiting.count).toBe(1))
      blocking = content.rss()
    }
    else {
      blocking = content.rss()
      await vi.waitFor(() => expect(gate.waiting.count).toBe(1))
      await background()
    }

    gate.open()
    const xml = await blocking
    await Promise.all(tasks)
    expect(xml).toContain(`<pubDate>${new Date(at(1)).toUTCString()}</pubDate>`)
    expect(fileHistories()).toHaveLength(1)
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it("keeps SEO available when the lease authority fails and retries later", async () => {
    fake.commit("main", { "content/a.md": page("A") }, { author: { date: at(1), name: "Ada" } })
    const dateLeases = createMemoryLeaseStore()
    const acquire = vi.spyOn(dateLeases, "acquire").mockRejectedValueOnce(new Error("Lease authority unavailable"))
    const content = sourceSite({ rss: true, dateLeases })
    expect(await content.sitemap()).toEqual([{ collection: "docs", id: "a", loc: "https://example.com/docs/a" }])
    expect(fileHistories()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Lease authority unavailable"))
    expect(await content.rss()).toContain(`<pubDate>${new Date(at(1)).toUTCString()}</pubDate>`)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(fileHistories()).toHaveLength(1)
  })

  it("releases an atomic date lease after a failed history read", async () => {
    fake.commit("main", { "content/a.md": page("A") }, { author: { date: at(1), name: "Ada" } })
    const dateLeases = createMemoryLeaseStore()
    const content = sourceSite({ rss: true, dateLeases })
    vi.stubGlobal("fetch", vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/graphql")) return new Response("Forbidden", { status: 403 })
      return await fake.fetch(input, init)
    }))
    const tasks: Promise<unknown>[] = []
    await content.rss({ waitUntil: task => tasks.push(task) })
    await Promise.all(tasks)
    expect(warn).toHaveBeenCalled()

    vi.stubGlobal("fetch", vi.fn(fake.fetch))
    expect(await content.rss()).toContain(`<pubDate>${new Date(at(1)).toUTCString()}</pubDate>`)
    expect(fileHistories()).toHaveLength(1)
  })

  it("computes the dates after a push webhook moves the head", async () => {
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "secret")
    vi.stubEnv("FORGES_GITHUB_WEBHOOK_SECRET", "")
    fake.commit("main", { "content/a.md": page("A"), "content/b.md": page("B") }, { author: { date: at(1), name: "Ada" } })
    const content = sourceSite()
    await content.sitemap()
    fake.commit("main", { "content/b.md": page("B v2") }, { author: { date: at(5), name: "Ada" } })
    const tasks: Promise<unknown>[] = []
    const push = fake.webhook("https://example.com/_vitehub/content/github", "secret")
    Object.defineProperty(push, "waitUntil", { value: (task: Promise<unknown>) => tasks.push(task) })

    expect((await defineContentGitHubWebhookHandler(content).fetch(push)).status).toBe(202)
    await Promise.all(tasks)
    const histories = fileHistories().length
    expect(histories).toBe(2)

    const read = hostRequest("https://example.com/rss.xml")
    const response = await defineContentRssHandler(content).fetch(read.request)
    expect(read.tasks).toHaveLength(0)
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate")
    expect(itemLinks(await response.text())[0]).toBe("https://example.com/docs/b")
    expect(fileHistories()).toHaveLength(histories)
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
