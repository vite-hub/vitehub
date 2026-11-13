import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memory, readArtifact } from "comark-content"
import sqlite from "comark-content/database/sqlite-node"
import sqlQuery from "comark-content/plugins/sql-query"
import markdown from "comark-content/plugins/markdown"
import schemaValidation from "comark-content/plugins/schema-validation"
import headings from "comark/plugins/headings"
import sqliteFullTextSearch from "comark-content/plugins/sqlite-full-text-search"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { CommitMemory, parserHash } from "../src/commit-cache.ts"
import { contentSource, defineContent, generateContentTypes, registerContentKV } from "../src/index.ts"
import { hubContent } from "../src/vite.ts"

import type { MockInstance } from "vitest"
import type { CacheArtifact, Manifest } from "comark-content"
import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub
let warn: MockInstance<typeof console.warn>

const page = (title: string, body = "Body\n") => `---\ntitle: ${title}\n---\n${body}`
/** Frontmatter that YAML cannot parse. */
const broken = "---\ntitle: [unclosed\n---\nBody\n"

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-head-"))
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
  // The build does this at the top of server/content.ts when the app enables KV.
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  warn.mockRestore()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** One Content runtime, as one server instance would create it. */
function server(options: Parameters<typeof defineContent>[0] = {}) {
  const content = defineContent({ route: "public", sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { url: "/:id" }) }, logger: false, ...options })
  cleanup.push(() => content.dispose())
  return content
}

async function title(content: ReturnType<typeof server>, path: string) {
  return (await content.get(path))?.data.title
}

/** The GitHub archives that the fake served. */
function downloads() {
  return fake.requests.filter(request => /\/tarball\/|\/tar\.gz\//.test(request.path)).length
}

/** The warnings with a diagnostic code. */
function warned(code: string) {
  return warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes(code))
}

describe("content.sources", () => {
  it("resolves the head on the first read and stores it in KV", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    const head = await content.sources.head("docs")
    expect(head).toMatchObject({ source: "docs", live: true, sha: first, ref: "main", pinned: false, rejected: null })
    expect(Date.parse(head.movedAt!)).not.toBeNaN()
    const [, stored] = await kv.get<{ sha: string }>("content:head:docs")
    expect(stored).toMatchObject({ sha: first, ref: "main" })
  })

  it("serves the head commit until advance() moves it to a valid push", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    // A push alone does not change what readers get.
    expect(await title(content, "/guide")).toBe("Guide")

    expect(await content.sources.advance("docs")).toMatchObject({ sha: second, rejected: null })
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(await title(content, "/new")).toBe("New")
  })

  it("keeps the last valid head when a push has a document that does not parse", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    const bad = fake.commit("main", { "guide.md": page("Guide v2"), "broken.md": broken })
    const head = await content.sources.advance("docs")

    expect(head).toMatchObject({ sha: first, rejected: { sha: bad, reason: expect.stringMatching(/^broken\.md: unexpected end of the stream/) } })
    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0019")).toEqual([expect.stringContaining(`Commit ${bad} of Content source "docs" failed validation, so Content keeps commit ${first}`)])

    // A rejected commit is not checked again, and a fixed push moves the head past it.
    await content.sources.advance("docs")
    expect(warned("CONTENT_R0019")).toHaveLength(1)
    const fixed = fake.commit("main", { "broken.md": page("Fixed") })
    expect(await content.sources.advance("docs")).toMatchObject({ sha: fixed, rejected: null })
    expect(await title(content, "/broken")).toBe("Fixed")
  })

  it("reads a head that another server moved after the in-memory hold expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const reader = server()
    const writer = server()
    expect(await title(reader, "/guide")).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await writer.sources.advance("docs")
    vi.advanceTimersByTime(4_000)
    expect(await title(reader, "/guide")).toBe("Guide")

    vi.advanceTimersByTime(1_500)
    expect(await title(reader, "/guide")).toBe("Guide v2")
    expect((await reader.sources.head("docs")).sha).toBe(second)
  })

  it.each(["manifest/docs", "manifest/docs.json", "manifest"])("updates a warm HTTP %s after another writer moves or pins the head", async (endpoint) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const reader = server()
    const writer = server()
    async function manifest() {
      const response = await reader.handler(new Request(`http://localhost/api/content/${endpoint}`))
      expect(response.status).toBe(200)
      const artifact = await response.json() as CacheArtifact
      return await readArtifact<Manifest>(artifact)
    }
    expect((await manifest()).items["/guide"]?.data.title).toBe("Guide")
    expect((await manifest()).items["/guide"]?.data.title).toBe("Guide")

    const second = fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    expect(await writer.sources.advance("docs")).toMatchObject({ sha: second })
    expect((await manifest()).items["/guide"]?.data.title).toBe("Guide")

    vi.setSystemTime(Date.now() + 5_001)
    expect((await manifest()).items["/guide"]?.data.title).toBe("Guide v2")
    expect((await manifest()).items["/new"]?.data.title).toBe("New")

    await writer.sources.pin(first, "docs")
    vi.setSystemTime(Date.now() + 5_001)
    const rolledBack = await manifest()
    expect(rolledBack.items["/guide"]?.data.title).toBe("Guide")
    expect(rolledBack.items["/new"]).toBeUndefined()

    await writer.sources.unpin("docs")
    vi.setSystemTime(Date.now() + 5_001)
    expect((await manifest()).items["/guide"]?.data.title).toBe("Guide v2")
  })

  it.each([
    "list", "list names", "get", "navigation", "search",
    "HTTP manifest", "HTTP manifest.json", "HTTP snapshot", "HTTP get", "HTTP bound get",
    "HTTP list", "HTTP list names", "HTTP search", "HTTP query",
  ])("keeps %s scoped when another Source cannot refresh", async (method) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    fake.commit("blog", { "guide.md": page("Blog") })
    const sources = {
      docs: github({ repo: "acme/docs", ref: "main" }),
      blog: github({ repo: "acme/docs", ref: "blog" }),
    }
    const writer = server({ sources })
    await writer.sources.head("docs")
    await writer.sources.head("blog")
    const database = sqlite()
    const reader = server({ sources, plugins: [sqlQuery({ database }), sqliteFullTextSearch({ database })] })
    await reader.list()
    async function read(name: string) {
      if (method === "list") return await reader.list(name)
      if (method === "list names") return await reader.list([name])
      if (method === "get") return await reader.get(`/${name}/guide.md`)
      if (method === "navigation") return await reader.navigation([name])
      if (method === "search") return await reader.search([name], "Body")
      const endpoints: Record<string, string> = {
        "HTTP manifest": `manifest/${name}`,
        "HTTP manifest.json": `manifest.json/${name}.json`,
        "HTTP snapshot": `snapshot/${name}.json`,
        "HTTP get": `get/${name}/guide.md`,
        "HTTP bound get": `get/guide?instance=${name}`,
        "HTTP list": `list/${encodeURIComponent(JSON.stringify(name))}`,
        "HTTP list names": `list/${encodeURIComponent(JSON.stringify([name]))}`,
        "HTTP search": `search/${encodeURIComponent(JSON.stringify({ sources: [name], query: "Body" }))}`,
        "HTTP query": `query/${encodeURIComponent(JSON.stringify({ source: name }))}`,
      }
      const response = await reader.handler(new Request(`http://localhost/api/content/${endpoints[method]}`))
      expect(response.status).toBe(200)
      return await response.json()
    }
    // Warm artifacts and indexes too; a cache hit must still sync only the selected Source.
    const before = await read("docs")
    expect(before).toBeTruthy()
    if (Array.isArray(before)) expect(before).not.toHaveLength(0)
    const second = fake.commit("blog", { "guide.md": page("Blog v2") })
    await writer.sources.advance("blog")
    const failedFetch = vi.fn()
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`)) {
        failedFetch()
        throw new Error("blog archive unavailable")
      }
      return fake.fetch(input, init)
    }))
    vi.advanceTimersByTime(5_500)

    expect(await read("docs")).toEqual(before)
    expect(failedFetch).not.toHaveBeenCalled()
    await expect(read("blog")).rejects.toThrow("blog archive unavailable")
    await expect(reader.list()).rejects.toThrow("blog archive unavailable")
  })

  it.each(["search", "HTTP search"])("keeps cached shared-index %s scoped without hiding requested Source failures", async (method) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    fake.commit("news", { "news.md": page("News") })
    fake.commit("blog", { "blog.md": page("Blog") })
    const sources = {
      docs: github({ repo: "acme/docs", ref: "main" }),
      news: github({ repo: "acme/docs", ref: "news" }),
      blog: github({ repo: "acme/docs", ref: "blog" }),
    }
    const writer = server({ sources })
    for (const name of Object.keys(sources)) await writer.sources.head(name)
    const reader = server({ sources, plugins: [sqliteFullTextSearch({ database: sqlite() })] })
    await reader.list()
    async function search(names = ["docs", "news"]) {
      if (method === "search") return await reader.search(names, "Body")
      const payload = encodeURIComponent(JSON.stringify({ sources: names, query: "Body" }))
      const response = await reader.handler(new Request(`http://localhost/api/content/search/${payload}`))
      expect(response.status).toBe(200)
      return await response.json() as unknown
    }
    const before = await search()
    expect(before).toHaveLength(2)
    const second = fake.commit("blog", { "blog.md": page("Blog v2") })
    await writer.sources.advance("blog")
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`)) throw new Error("blog archive unavailable")
      return fake.fetch(input, init)
    }))
    vi.advanceTimersByTime(5_500)

    expect(await search()).toEqual(before)
    await expect(search(["blog", "news"])).rejects.toThrow("blog archive unavailable")
    // Empty filters and public paths still select all Sources, as does the merged HTTP manifest.
    for (const read of [
      () => reader.list([]),
      () => reader.navigation([]),
      () => reader.search([], "Body"),
      () => reader.get("/guide"),
      () => reader.handler(new Request("http://localhost/api/content/manifest")),
    ]) await expect(read()).rejects.toThrow("blog archive unavailable")
  })

  it("pins a commit until unpin()", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")

    expect(await content.sources.pin(first, "docs")).toMatchObject({ sha: first, pinned: true })
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.advance("docs")).toMatchObject({ sha: first, pinned: true })

    expect(await content.sources.unpin("docs")).toMatchObject({ sha: second, pinned: false })
    expect(await title(content, "/guide")).toBe("Guide v2")
    await expect(content.sources.pin("main", "docs")).rejects.toMatchObject({ code: "CONTENT_R0008" })
  })

  it("reads the branch without a head when there is no token", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.head("docs")).toMatchObject({ live: false, sha: null })
    expect(warned("CONTENT_R0020")).toEqual([expect.stringContaining("VITEHUB_GITHUB_TOKEN")])
    const [, stored] = await kv.get("content:head:docs")
    expect(stored).toBeNull()
    await expect(content.sources.pin(fake.head("main")!, "docs")).rejects.toMatchObject({ code: "CONTENT_R0020" })
  })

  it("reads the branch without a head when the app has no KV store", async () => {
    registerContentKV(undefined)
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(await content.sources.head("docs")).toMatchObject({ live: false, sha: null })
    expect(warned("CONTENT_R0021")).toEqual([expect.stringContaining("Remove `kv: false`")])
    await expect(content.sources.pin(fake.head("main")!, "docs")).rejects.toMatchObject({ code: "CONTENT_R0021" })
  })

  it("serves the branch and logs CONTENT_R0022 when KV fails on a read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const failing = { get: vi.fn(async () => { throw new Error("KV binding is missing") }), set: vi.fn(async () => [undefined, undefined] as const) }
    registerContentKV(failing)
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()

    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0022")).toEqual([expect.stringContaining(`The KV store failed on "content:head:docs" for Content source "docs": KV binding is missing`)])
    expect(await content.sources.head("docs").catch((error: unknown) => error)).toMatchObject({ code: "CONTENT_R0022" })
    // Reads wait 5 seconds before they call the failing store again.
    failing.get.mockClear()
    vi.advanceTimersByTime(5_500)
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/guide")).toBe("Guide")
    expect(failing.get).toHaveBeenCalledTimes(1)
    expect(failing.set).not.toHaveBeenCalled()
    // An explicit call reports the failure to the caller.
    await expect(content.sources.advance("docs")).rejects.toMatchObject({ code: "CONTENT_R0022" })
  })

  it("keeps the validated commit that it serves when KV starts to fail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")

    registerContentKV({ get: async () => [new Error("KV is down"), null] as const, set: async () => [new Error("KV is down"), null] as const })
    fake.commit("main", { "guide.md": page("Guide v2") })
    vi.advanceTimersByTime(5_500)
    expect(await title(content, "/guide")).toBe("Guide")
    expect(warned("CONTENT_R0022")).toEqual([expect.stringContaining("KV is down")])
    // Without the fallback to the served commit, the read would load the latest commit of the branch.
    expect(fake.head("main")).not.toBe(first)
  })

  it.each(["query", "sitemap", "init", "types", "source"])("establishes and updates the head for cold %s reads", async (method) => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const first = fake.commit("main", { "guide.md": page("Guide") })
    await server().sources.pin(first, "docs")
    const second = fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    const content = server({ plugins: [sqlQuery({ database: sqlite() })] })
    async function read() {
      if (method === "query") return (await content.query("docs").all()).map(item => item.path)
      if (method === "source") return await content.getSource("docs")!.keys()
      if (method === "sitemap") return (await content.sitemap()).map(item => item.loc)
      if (method === "types") await generateContentTypes(content)
      else await content.init()
      return (await content.instances[0]!.list()).map(item => item.path)
    }
    expect(await read()).toHaveLength(1)
    expect(await content.instances[0]!.get("/guide")).toMatchObject({ data: { title: "Guide" } })
    await server().sources.unpin("docs")
    vi.advanceTimersByTime(5_500)
    expect(await read()).toHaveLength(2)
    expect(await content.sources.head("docs")).toMatchObject({ sha: second })
  })

  it("does not serve a rejected initial commit and can explicitly retry the same SHA", async () => {
    const sha = fake.commit("main", { "guide.md": page("Guide") })
    let failing = true
    const content = server({ markdown: { plugins: [{ name: "reject-body", post() { if (failing) throw new Error("Body is invalid") } }] } })
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.head("docs")).toMatchObject({ live: true, sha: null, rejected: { sha, reason: expect.stringContaining("Body is invalid") } })
    failing = false
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.advance("docs")).toMatchObject({ sha, rejected: null })
    expect(await title(content, "/guide")).toBe("Guide")
  })

  it("does not serve the branch when the initial commit cannot be resolved", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("/commits/main")) return new Response("rate limited", { status: 429 })
      return fake.fetch(input, init)
    }))
    const content = server()
    await expect(content.list("docs")).rejects.toBeDefined()
    expect(await content.sources.head("docs")).toMatchObject({ live: true, sha: null })
  })

  it("does not restore a parsed cache from another selected commit on a cold rollback", async () => {
    const driver = memory()
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server({ cache: { driver } })
    expect(await title(content, "/guide")).toBe("Guide")
    fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")
    expect(await title(content, "/guide")).toBe("Guide v2")
    await server({ cache: { driver } }).sources.pin(first, "docs")
    const cold = server({ cache: { driver } })
    expect(await cold.sources.head("docs")).toMatchObject({ sha: first, pinned: true })
    expect(await title(cold, "/guide")).toBe("Guide")
  })

  it("rebuilds a shared SQL index before executing a cold query at a pinned head", async () => {
    const database = sqlite()
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server({ plugins: [sqlQuery({ database })] })
    expect(await content.query("docs").count()).toBe(1)
    fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    await content.sources.advance("docs")
    expect(await content.query("docs").count()).toBe(2)
    await server().sources.pin(first, "docs")
    const cold = server({ plugins: [sqlQuery({ database })] })
    const query = cold.query("docs").where("path", "=", "/guide")
    expect(await query.first()).toMatchObject({ data: { title: "Guide" } })
    expect(await cold.query("docs").count()).toBe(1)
  })

  it("retries a selected head when its serving refresh failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    // Another server instance validates the new commit and moves the head.
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    await server().sources.advance("docs")
    // This server instance cannot read the commit from KV, and its archive download fails until `failing` is false.
    registerContentKV({ get: key => key.startsWith("content:head:") ? kv.get(key) : Promise.resolve([undefined, undefined]), set: (key, value) => kv.set(key, value) })
    let failing = true
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`) && failing) throw new TypeError("fetch failed")
      return fake.fetch(input, init)
    }))
    vi.advanceTimersByTime(5_500)
    await expect(title(content, "/guide")).rejects.toThrow("fetch failed")
    failing = false
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(await content.sources.head("docs")).toMatchObject({ sha: second })
  })

  it("retries a valid rejected SHA after a temporary retrieval failure and restart", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const second = fake.commit("main", { "guide.md": page("Guide v2") })
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes(`/tarball/${second}`)) throw new TypeError("fetch failed")
      return fake.fetch(input, init)
    }))
    expect(await content.sources.advance("docs")).toMatchObject({ rejected: { sha: second } })
    vi.stubGlobal("fetch", vi.fn(fake.fetch))
    const restarted = server()
    expect(await restarted.sources.advance("docs")).toMatchObject({ sha: second, rejected: null })
    expect(await title(restarted, "/guide")).toBe("Guide v2")
  })

  it("names the Sources that have a head", async () => {
    const content = server()
    await expect(content.sources.head()).rejects.toMatchObject({ code: "CONTENT_R0008", message: expect.stringContaining("Sources with a head: docs") })
  })
})

describe("commit cache", () => {
  it("downloads each commit once, and a server with a warm KV downloads nothing", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide"), "intro.md": page("Intro") })
    const content = server()

    // Validation and serving share the download.
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/intro")).toBe("Intro")
    expect(downloads()).toBe(1)
    const head = await content.sources.head("docs")
    expect(head.cache).toEqual({ key: expect.stringMatching(new RegExp(`^content:[0-9a-f]{16}:${first}:docs$`)), hits: { memory: expect.any(Number), build: 0, kv: 0 }, misses: 1 })
    const [, stored] = await kv.get(head.cache.key!)
    expect(stored).toMatchObject({ name: "docs", data: expect.any(String) })

    const other = server()
    expect(await title(other, "/guide")).toBe("Guide")
    expect((await other.list()).length).toBe(2)
    expect(downloads()).toBe(1)
    expect((await other.sources.head("docs")).cache).toMatchObject({ key: head.cache.key, hits: { kv: 1 }, misses: 0 })

    // A new head is a new key: one more download, shared by advance() and the reload.
    fake.commit("main", { "guide.md": page("Guide v2") })
    await content.sources.advance("docs")
    expect(await title(content, "/guide")).toBe("Guide v2")
    expect(downloads()).toBe(2)
  })

  it("keeps documents that a server changes out of the cached commit", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    fake.commit("main", { "guide.md": page("Guide v2"), "new.md": page("New") })
    await content.sources.advance("docs")
    expect(await title(content, "/new")).toBe("New")

    // A rollback reads the first commit from memory: no download, and no document of the second commit.
    await content.sources.pin(first, "docs")
    expect(await title(content, "/guide")).toBe("Guide")
    expect(await title(content, "/new")).toBeUndefined()
    expect((await content.list()).map(item => item.path)).toEqual(["/guide"])
    expect(downloads()).toBe(2)
  })

  it("stores no rejected commit", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const bad = fake.commit("main", { "broken.md": broken })
    await content.sources.advance("docs")
    const key = (await content.sources.head("docs")).cache.key!.replace(/:[0-9a-f]{40}:/, `:${bad}:`)
    const [, stored] = await kv.get(key)
    expect(stored).toBeNull()
    expect(downloads()).toBe(2)
  })

  it("uses another key when the parser config changes", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const { key } = (await content.sources.head("docs")).cache

    const other = server({ markdown: { autoClose: false } })
    expect(await title(other, "/guide")).toBe("Guide")
    const changed = (await other.sources.head("docs")).cache
    expect(changed.key).not.toBe(key)
    expect(changed.key?.split(":")[2]).toBe(key?.split(":")[2])
    expect(changed).toMatchObject({ hits: { kv: 0 }, misses: 1 })
    expect(downloads()).toBe(2)

    // A plugin counts by its source text, so a changed plugin gives another hash.
    const plugin = (version: number) => ({ name: "plugin", setup: version === 1 ? () => "one" : () => "two" })
    expect(await parserHash({ plugins: [plugin(1)] })).not.toBe(await parserHash({ plugins: [plugin(2)] }))
    expect(await parserHash({ plugins: [plugin(1)] })).toBe(await parserHash({ plugins: [plugin(1)] }))
  })

  it("uses another key for each build, because plugin options in closures do not change the parser hash", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    registerContentKV(kv, "build-1")
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide")
    const { key } = (await content.sources.head("docs")).cache
    registerContentKV(kv, "build-2")
    const next = server()
    expect(await title(next, "/guide")).toBe("Guide")
    expect((await next.sources.head("docs")).cache).toMatchObject({ hits: { kv: 0 }, misses: 1 })
    expect((await next.sources.head("docs")).cache.key).not.toBe(key)
  })

  it("keeps the Source prefix and schema in the cached commit", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    const docs = () => contentSource(github({ repo: "acme/docs", ref: "main" }), { prefix: "/docs" })
    const content = defineContent({ route: "public", sources: { docs: docs() }, logger: false })
    cleanup.push(() => content.dispose())
    expect((await content.get("/docs/guide"))?.data.title).toBe("Guide")
    const cold = defineContent({ route: "public", sources: { docs: docs() }, logger: false })
    cleanup.push(() => cold.dispose())
    expect((await cold.get("/docs/guide"))?.data.title).toBe("Guide")
    expect((await cold.sources.head("docs")).cache).toMatchObject({ hits: { kv: 1 }, misses: 0 })
  })

  it.each(["markdown", "content"] as const)("reparses cached files with changed %s plugin closures in the same build", async (kind) => {
    fake.commit("main", { "guide.md": "# Guide\n\nDescription\n" })
    registerContentKV(kv, "same-build")
    const configured = (remove: boolean) => server(kind === "markdown"
      ? { markdown: { plugins: [headings({ remove })] } }
      : { plugins: [markdown({ comark: { plugins: [headings({ remove })] } })] })
    const tags = async (content: ReturnType<typeof configured>) => (await content.get("/guide"))?.nodes?.map(node => Array.isArray(node) ? node[0] : null)
    const warm = configured(false)
    expect(await tags(warm)).toEqual(expect.arrayContaining(["h1", "p"]))
    const key = (await warm.sources.head("docs")).cache.key

    const cold = configured(true)
    const removed = await tags(cold)
    expect(removed).not.toContain("h1")
    expect(removed).not.toContain("p")
    expect((await cold.sources.head("docs")).cache).toMatchObject({ key, hits: { kv: 1 }, misses: 0 })
    expect(downloads()).toBe(1)
  })

  it("isolates different Source prefixes in the same build", async () => {
    fake.commit("main", { "guide.md": page("Guide") })
    registerContentKV(kv, "same-build")
    const configured = (prefix: string) => server({ sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { prefix }) } })
    const docs = configured("/docs")
    expect(await title(docs, "/docs/guide")).toBe("Guide")
    const key = (await docs.sources.head("docs")).cache.key

    const help = configured("/help")
    expect((await help.list()).map(item => item.path)).toEqual(["/help/guide"])
    expect(await title(help, "/help/guide")).toBe("Guide")
    expect((await help.sources.head("docs")).cache.key).not.toBe(key)
    const cold = configured("/help")
    expect(await title(cold, "/help/guide")).toBe("Guide")
    expect((await cold.sources.head("docs")).cache).toMatchObject({ hits: { kv: 1 }, misses: 0 })
  })

  it("isolates Source schemas and rejects a commit cached under a permissive schema", async () => {
    const first = fake.commit("main", { "guide.md": page("Guide") })
    registerContentKV(kv, "same-build")
    const configured = (type: "string" | "number") => server({
      sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main" }), { prefix: "/docs", schema: { type: "object", properties: { title: { type } } } }) },
      plugins: [schemaValidation()],
    })
    const strict = configured("string")
    expect(await title(strict, "/docs/guide")).toBe("Guide")
    const key = (await strict.sources.head("docs")).cache.key
    const bad = fake.commit("main", { "guide.md": page("123") })
    const permissive = configured("number")
    await permissive.sources.advance("docs")
    const badKey = (await permissive.sources.head("docs")).cache.key
    // Return the shared head to the valid commit, while retaining the numeric commit artifact in KV.
    await strict.sources.pin(first, "docs")
    expect(await strict.sources.unpin("docs")).toMatchObject({ sha: first, rejected: { sha: bad, reason: expect.stringContaining("guide.md") } })
    expect(badKey).not.toBe(key!.replace(first, bad))
    expect(await title(strict, "/docs/guide")).toBe("Guide")
  })

  it("holds a bounded number of commits in memory", async () => {
    const shas = [fake.commit("main", { "guide.md": page("Guide 0") })]
    const content = server()
    expect(await title(content, "/guide")).toBe("Guide 0")
    for (let index = 1; index < 6; index++) {
      shas.push(fake.commit("main", { "guide.md": page(`Guide ${index}`) }))
      await content.sources.advance("docs")
    }
    expect(downloads()).toBe(6)

    // The first commit left memory, so the rollback reads it from KV, not from GitHub.
    const before = (await content.sources.head("docs")).cache.hits.kv
    await content.sources.pin(shas[0]!, "docs")
    expect(await title(content, "/guide")).toBe("Guide 0")
    expect((await content.sources.head("docs")).cache.hits.kv).toBe(before + 1)
    expect(downloads()).toBe(6)

    const memory = new CommitMemory<number>(2)
    for (let index = 0; index < 10; index++) memory.set(String(index), index)
    expect(memory.size).toBe(2)
    expect(memory.get("8")).toBe(8)
    memory.set("10", 10)
    expect(memory.get("9")).toBeUndefined()
  })
})

describe("hubContent() and KV", () => {
  async function transform(plugins: string[], command: "build" | "serve" = "serve") {
    const root = await mkdtemp(join(tmpdir(), "vitehub-content-head-vite-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, "server"))
    await writeFile(join(root, "server/content.ts"), "export default {}\n")
    const plugin = hubContent()
    // SAFETY: The plugin reads only these fields of the resolved config and of the transform context.
    const configResolved = plugin.configResolved as (config: unknown) => void
    configResolved({ root, plugins: plugins.map(name => ({ name })), resolve: { alias: [] } })
    const { handler } = plugin.transform as { handler: (this: unknown, code: string, id: string) => Promise<{ code: string } | undefined> }
    return await handler.call({ environment: { config: { consumer: "server", command } } }, "export default {}\n", join(root, "server/content.ts"))
  }

  it("gives server/content.ts the app's KV store when the app enables KV", async () => {
    const result = await transform(["@vite-hub/kv/vite"])
    expect(result?.code).toContain(`import { kv as __vitehubContentKV } from "@vite-hub/kv"`)
    expect(result?.code).toContain("__vitehubRegisterContentKV(__vitehubContentKV, ")
  })

  it("imports no KV when the app does not enable it", async () => {
    expect(await transform([])).toBeUndefined()
  })
})
