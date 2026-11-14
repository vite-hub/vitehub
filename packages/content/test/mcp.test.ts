import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { files, github } from "@vite-hub/source"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { documents } from "../src/collections.ts"
import { contentSource, defineContent, defineContentMcpHandler, registerContentKV, seo } from "../src/index.ts"
import { contentPageCharacters } from "../src/mcp.ts"
import { historyWorkspace } from "./history-workspace.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-mcp-"))
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
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

interface McpResponse {
  status: number
  body: { result?: { content?: Array<{ type: string, text: string }>, isError?: boolean, tools?: Array<{ name: string }> }, error?: { code: number } }
}

async function call(handler: ReturnType<typeof defineContentMcpHandler>, method: string, params: Record<string, unknown> = {}, origin = "https://example.com"): Promise<McpResponse> {
  const response = await handler.fetch(new Request(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }))
  // SAFETY: The tests read only the fields that MCP defines for these methods.
  return { status: response.status, body: await response.json() as McpResponse["body"] }
}

const tool = async (handler: ReturnType<typeof defineContentMcpHandler>, name: string, args: Record<string, unknown> = {}) =>
  (await call(handler, "tools/call", { name, arguments: args })).body.result!

/** The tool text of a JSON value: two-space JSON, as the MCP server of `@vite-hub/docs` sent it before docs moved onto this server. */
async function docsText(value: unknown): Promise<string> {
  return JSON.stringify(value, null, 2)
}

describe("seo.mcp for collections", () => {
  async function site(mcp: unknown = true) {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({
      workspace,
      logger: false,
      collections: {
        posts: documents({ path: "posts/*.md", url: "/blog/:id", fields: { title: z.string(), description: z.string().optional(), seo: seo() } }),
        data: documents({ path: "data/*.json", url: "/data/:id", fields: { title: z.string() } }),
      },
      // SAFETY: Some tests pass an invalid option on purpose.
      seo: { site: "https://example.com", mcp } as never,
    })
    cleanup.push(() => content.dispose())
    return content
  }

  it("lists published Markdown pages without drafts and noindex pages", async () => {
    const content = await site()
    const posts = content.collection("posts")
    await posts.save("hello", { data: { title: "Hello", description: "First post" }, body: "Read [the guide](/blog/guide).\n" })
    await posts.save("guide", { data: { title: "Guide" }, body: "# Own heading\n\nSteps.\n" })
    await posts.save("hidden", { data: { title: "Hidden", seo: { noindex: true } }, body: "Secret\n" })
    await posts.save("draft", { data: { title: "Draft" }, body: "Not yet\n" })
    await content.collection("data").save("numbers", { data: { title: "Numbers" } })
    await content.publish({ collection: "posts", ids: ["hello", "guide", "hidden"] })
    await content.publish({ collection: "data" })
    // A draft change after the publish stays out.
    await posts.save("hello", { data: { title: "Draft title" }, body: "Draft body\n" })
    const handler = defineContentMcpHandler(content)

    const listed = await tool(handler, "list-pages")
    const pages = [
      { title: "Guide", path: "/blog/guide", url: "https://example.com/blog/guide" },
      { title: "Hello", path: "/blog/hello", description: "First post", url: "https://example.com/blog/hello" },
    ]
    expect(listed.isError).toBe(false)
    expect(listed.content).toEqual([{ type: "text", text: await docsText(pages) }])
    expect(await content.pages()).toEqual(pages)

    const page = await tool(handler, "get-page", { path: "/blog/hello" })
    expect(page.isError).toBe(false)
    expect(page.content![0]!.text).toBe(await docsText({
      title: "Hello",
      path: "/blog/hello",
      description: "First post",
      content: "# Hello\n\n> First post\n\nRead [the guide](https://example.com/blog/guide).\n",
      url: "https://example.com/blog/hello",
    }))
    // The path may be a URL, end in a slash or `.md`, or differ in case.
    for (const path of ["https://example.com/blog/guide", "/blog/guide/", "blog/guide.md", "/Blog/Guide"]) {
      expect(JSON.parse((await tool(handler, "get-page", { path })).content![0]!.text)).toMatchObject({ path: "/blog/guide", content: "# Own heading\n\nSteps.\n" })
    }
  })

  it("answers an unknown or draft page with the error text of the docs MCP server, and reads a noindex page", async () => {
    const content = await site()
    await content.collection("posts").save("hidden", { data: { title: "Hidden", seo: { noindex: true } }, body: "Unlisted\n" })
    await content.collection("posts").save("draft", { data: { title: "Draft" }, body: "Not yet\n" })
    await content.publish({ collection: "posts", ids: ["hidden"] })
    const handler = defineContentMcpHandler(content)
    for (const path of ["/blog/missing", "/blog/draft", "/data/numbers"]) {
      expect(await tool(handler, "get-page", { path })).toEqual({ content: [{ type: "text", text: `[404] No page at ${path}` }], isError: true })
    }
    // A noindex page has a `.md` copy, so get-page reads it by its path. list-pages does not list it.
    expect(await content.page("/blog/hidden")).toMatchObject({ path: "/blog/hidden", content: "# Hidden\n\nUnlisted\n" })
    expect((await content.pages()).map(page => page.path)).not.toContain("/blog/hidden")
    expect((await tool(handler, "get-page", {})).isError).toBe(true)
  })

  it("serves the MCP protocol, takes the request origin, and pages through long lists", async () => {
    const workspace = await historyWorkspace(cleanup)
    const content = defineContent({ workspace, logger: false, collections: { posts: documents({ path: "posts/*.md", url: "/blog/:id", fields: { title: z.string() } }) }, seo: { mcp: { name: "Shop blog" } } })
    cleanup.push(() => content.dispose())
    for (const id of ["a", "b", "c"]) await content.collection("posts").save(id, { data: { title: id.toUpperCase() }, body: `${id}\n` })
    await content.publish({ collection: "posts" })
    const handler = defineContentMcpHandler(content)

    const initialize = await call(handler, "initialize", { protocolVersion: "2025-11-25" }, "https://shop.test")
    expect(initialize.body.result).toMatchObject({ serverInfo: { name: "Shop blog" }, capabilities: { tools: { listChanged: false } } })
    expect((await call(handler, "tools/list")).body.result!.tools!.map(entry => entry.name)).toEqual(["list-pages", "get-page"])
    const text = (await call(handler, "tools/call", { name: "list-pages", arguments: { offset: 2 } }, "https://shop.test")).body.result!.content![0]!.text
    expect(JSON.parse(text)).toEqual([{ title: "C", path: "/blog/c", url: "https://shop.test/blog/c" }])
    expect((await handler.fetch(new Request("https://shop.test/mcp"))).status).toBe(405)
    expect((await tool(handler, "list-pages", { offset: -1 })).isError).toBe(true)
    await expect(content.pages({ limit: 0 })).rejects.toMatchObject({ code: "CONTENT_R0070" })
    expect(await content.pages({ offset: 1, limit: 1 })).toEqual([{ title: "B", path: "/blog/b", url: "http://localhost/blog/b" }])
  })

  it("cuts a long page and answers 404 when mcp is off", async () => {
    const content = await site()
    await content.collection("posts").save("long", { data: { title: "Long" }, body: `${"word ".repeat(contentPageCharacters / 5)}\n` })
    await content.publish({ collection: "posts" })
    const page = await content.page("/blog/long")
    expect(page!.content.length).toBeLessThan(contentPageCharacters + 200)
    expect(page!.content).toMatch(/ends here\. Open https:\/\/example\.com\/blog\/long for the rest\.\]\n$/)

    const off = await site(false)
    expect((await defineContentMcpHandler(off).fetch(new Request("https://example.com/mcp", { method: "POST" }))).status).toBe(404)
    await expect(site({ name: "" })).rejects.toMatchObject({ code: "CONTENT_R0006" })
    await expect(site("yes")).rejects.toMatchObject({ code: "CONTENT_R0006" })
  })
})

describe("seo.mcp for Sources", () => {
  it("lists no Source noindex or differing canonical page, but reads them by path", async () => {
    fake.commit("main", {
      "content/public.md": "---\ntitle: Public\nseo:\n  canonical: https://example.com/docs/public\n---\nPublic body.\n",
      "content/hidden.md": "---\ntitle: Hidden\nseo:\n  noindex: true\n---\nHidden body.\n",
      "content/elsewhere.md": "---\ntitle: Elsewhere\nseo:\n  canonical: https://elsewhere.test/original\n---\nElsewhere body.\n",
    })
    const content = defineContent({
      access: "public",
      logger: false,
      sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main", root: "content" }), { url: "/docs/:id" }) },
      seo: { site: "https://example.com", mcp: true },
    })
    cleanup.push(() => content.dispose())
    const handler = defineContentMcpHandler(content)
    expect((await content.pages()).map(page => page.path)).toEqual(["/docs/public"])
    expect(JSON.parse((await tool(handler, "list-pages")).content![0]!.text).map((page: { path: string }) => page.path)).toEqual(["/docs/public"])
    for (const path of ["/docs/hidden", "/docs/elsewhere"]) {
      expect(await content.page(path)).toMatchObject({ path })
      expect(JSON.parse((await tool(handler, "get-page", { path })).content![0]!.text)).toMatchObject({ path })
    }
  })

  it.each(["files", "items"] as const)("reads the refreshed Markdown of a %s Source", async (kind) => {
    let text = "---\ntitle: One\n---\nBody one.\n"
    let added = false
    const input = kind === "files"
      ? files({ "a.md": () => text })
      : { async items() { return added ? [{ key: "b.md", content: "---\ntitle: B\n---\nBody B.\n" }] : [{ key: "a.md", content: text }] } }
    const content = defineContent({
      access: "public",
      route: false,
      logger: false,
      sources: { notes: contentSource(input, { url: "/notes/:id" }) },
      seo: { mcp: true },
    })
    cleanup.push(() => content.dispose())
    expect((await content.page("/notes/a"))?.content).toBe("# One\n\nBody one.\n")
    text = "---\ntitle: Two\n---\nBody two.\n"
    await content.cache.refresh("notes")
    expect(await content.page("/notes/a")).toMatchObject({ title: "Two", content: "# Two\n\nBody two.\n" })
    if (kind === "items") {
      added = true
      await content.cache.refresh("notes")
      expect((await content.pages()).map(page => page.path)).toEqual(["/notes/b"])
      expect((await content.page("/notes/b"))?.content).toBe("# B\n\nBody B.\n")
      expect(await content.page("/notes/a")).toBeNull()
    }
  })

  it("reads the file of the head commit without its frontmatter", async () => {
    fake.commit("main", {
      "content/guide.md": "---\ntitle: Guide\ndescription: Start here\n---\n\nSee [intro](/docs/intro).\n\n::note\nKept as written.\n::\n",
      "content/intro.md": "---\ntitle: Intro\n---\n# Intro heading\n\nHi.\n",
      "content/data.json": "{\"title\":\"Data\"}\n",
    })
    const content = defineContent({
      access: "public",
      logger: false,
      sources: { docs: contentSource(github({ repo: "acme/docs", ref: "main", root: "content" }), { url: "/docs/:id" }) },
      seo: { site: "https://example.com", mcp: true },
    })
    cleanup.push(() => content.dispose())
    const handler = defineContentMcpHandler(content)

    expect(JSON.parse((await tool(handler, "list-pages")).content![0]!.text)).toEqual([
      { title: "Guide", path: "/docs/guide", description: "Start here", url: "https://example.com/docs/guide" },
      { title: "Intro", path: "/docs/intro", url: "https://example.com/docs/intro" },
    ])
    expect(JSON.parse((await tool(handler, "get-page", { path: "/docs/guide" })).content![0]!.text).content)
      .toBe("# Guide\n\n> Start here\n\nSee [intro](https://example.com/docs/intro).\n\n::note\nKept as written.\n::\n")

    fake.commit("main", { "content/intro.md": "---\ntitle: Intro v2\n---\nNew text.\n" })
    await content.sources.advance("docs")
    expect(await content.page("/docs/intro")).toEqual({ title: "Intro v2", path: "/docs/intro", url: "https://example.com/docs/intro", content: "# Intro v2\n\nNew text.\n" })
  })

  it("reads a Source without a head commit as it is", async () => {
    const content = defineContent({
      access: "public",
      route: false,
      logger: false,
      sources: { notes: contentSource({ async items() { return [{ key: "a.md", content: "---\ntitle: A\n---\nBody of A.\n" }] } }, { url: "/notes/:id" }) },
      seo: { mcp: true },
    })
    cleanup.push(() => content.dispose())
    expect(await content.page("/notes/a")).toEqual({ title: "A", path: "/notes/a", url: "http://localhost/notes/a", content: "# A\n\nBody of A.\n" })
  })
})
