import { globSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { H3 } from "h3"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DocsPublicConfig } from "../src/nuxt.ts"

const fixtures = resolve(import.meta.dirname, "fixtures/content")
const readFixture = async (key: string) => readFileSync(join(fixtures, key.replaceAll(":", "/")), "utf8")
const getItem = vi.fn<(key: string) => Promise<unknown>>(readFixture)
const getKeys = vi.fn(async () => globSync("**/*.md", { cwd: fixtures }).map(key => key.replaceAll("/", ":")))
// The pages that the `rawMarkdown` option rewrote at build time.
const rewritten = new Map<string, string>()
const useKV = vi.fn((base: string) => base === "assets:docs-agent"
  ? { getItem: async (key: string) => rewritten.get(key) ?? null }
  : { getItem, getKeys, getItemRaw: getItem })
const docsConfig: Pick<DocsPublicConfig, "site" | "sitemap" | "appBase" | "mcp"> = {
  appBase: "/",
  site: { name: "Fixture", url: "https://docs.example.com", description: "Fixture docs.", logo: null, badge: null },
  sitemap: ["/tutorials", "/docs/kv", "/a&b"],
  mcp: { name: "fixture", url: "https://docs.example.com/mcp", guide: null },
}

// The handlers use the real `nitro/h3`. Storage and runtime config need a Nitro build, so they are fakes.
vi.mock("nitro/kv", () => ({ useKV }))
vi.mock("nitro/runtime-config", () => ({ useRuntimeConfig: () => ({ public: { docs: docsConfig } }) }))
vi.mock("#docs/content", () => ({ content: undefined }))
vi.mock("#docs/agent", () => ({ default: { llms: { details: "Rules for agents.", sections: [{ title: "Links", links: [{ title: "API", href: "https://docs.example.com/openapi.json" }] }] } } }))
// The app's `parser` module: a Comark plugin that adds a paragraph, so the test sees which parser ran.
vi.mock("#docs/example-sources", () => ({ default: {} }))
vi.mock("#docs/parser", () => ({
  default: { plugins: [{ name: "app-plugin", post: (state: { tree: { nodes: unknown[] } }) => void state.tree.nodes.push(["p", {}, "Added by the app plugin"]) }] },
  githubRepo: "vite-hub/vitehub",
}))
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return { default: await createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" }) }
})

const { default: raw } = await import("../src/runtime/server/raw.ts")
const { default: sitemap } = await import("../src/runtime/server/sitemap.ts")
const { default: llms } = await import("../src/runtime/server/llms.ts")
const { default: mcp } = await import("../src/runtime/server/mcp.ts")
const { default: page } = await import("../src/runtime/server/page.ts")
const { default: search } = await import("../src/runtime/server/search.ts")
const { docsAgentCopy } = await import("../src/agent-copy.ts")
const { findDocsPage } = await import("../src/navigation.ts")
const { default: manifest } = await import("#docs/manifest")
const app = new H3().get("/raw/**", raw).get("/sitemap.xml", sitemap).get("/llms.txt", llms).get("/llms-full.txt", llms).get("/sitemap.md", llms).post("/mcp", mcp)

/** The copy of a fixture page, from the file as the build bundles it. */
async function copyOf(path: string, siteUrl = "https://docs.example.com") {
  const found = findDocsPage(manifest, path)!.page
  return docsAgentCopy(manifest, found, await readFixture(found.file), siteUrl)
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await app.fetch(new Request("https://docs.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }))
  const body = await response.json() as { result: { content: Array<{ text: string }>, isError?: boolean } }
  return body.result
}

beforeEach(() => {
  vi.clearAllMocks()
  getItem.mockImplementation(readFixture)
  rewritten.clear()
  docsConfig.appBase = "/"
  docsConfig.site.url = "https://docs.example.com"
})

describe("parser option", () => {
  const app = new H3().get("/api/_docs/page/**", page).get("/api/_docs/search.json", search)

  it("parses the page route and search with the app's Comark plugins and the site's repository", async () => {
    getItem.mockImplementation(async key => `${await readFixture(key)}\nFixed in #12.\n`)
    const response = await app.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
    const { nodes } = (await response.json()).document
    expect(nodes).toContainEqual(["p", {}, "Added by the app plugin"])
    // `docs.github.repo` is the repository that `#12` links to.
    expect(JSON.stringify(nodes)).toContain("https://github.com/vite-hub/vitehub/issues/12")
    const index = await app.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
    expect(await index.json()).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^\/docs\/kv/), content: expect.stringContaining("Added by the app plugin") }))
  })
})

describe("raw Markdown route", () => {
  it("serves the agent copy of a page from Content, with the links of its section", async () => {
    const response = await app.fetch(new Request("https://docs.example.com/raw/docs/kv/configure.md"))
    const copy = await copyOf("/docs/kv/configure")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await response.text()).toBe(`${copy.markdown}${copy.footer}`)
    expect(copy.footer).toContain("<!-- vitehub-docs:section-links -->")
  })

  it("serves the home page from its own raw copy", async () => {
    const copy = await copyOf("/")
    const response = await app.fetch(new Request("https://docs.example.com/raw/index.md"))
    expect(await response.text()).toBe(`${copy.markdown}${copy.footer}`)
  })

  it("reads the pages that rawMarkdown rewrote at build time", async () => {
    rewritten.set("docs_0/docs/kv/ttl.md", "---\ntitle: TTL\n---\nRewritten for agents.\n")
    expect(await (await app.fetch(new Request("https://docs.example.com/raw/docs/kv/ttl.md"))).text()).toContain("Rewritten for agents.")
    expect(useKV).toHaveBeenCalledWith("assets:docs-agent")
  })

  it.each(["/raw/missing.md", "/raw/docs/kv.html", "/raw/docs/kv/index.md"])("returns 404 for %s", async (path) => {
    const response = await app.fetch(new Request(`https://docs.example.com${path}`))
    expect(response.status).toBe(404)
  })
})

describe("sitemap route", () => {
  it("lists every indexed page from Content and the extra paths once, sorted, on the canonical origin", async () => {
    const response = await app.fetch(new Request("https://preview.example.com/sitemap.xml"))
    const body = await response.text()
    const locations = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])

    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8")
    expect(body.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">")).toBe(true)
    expect(locations).toEqual([...locations].sort())
    expect(new Set(locations).size).toBe(locations.length)
    expect(locations).toContain("https://docs.example.com/")
    expect(locations).toContain("https://docs.example.com/about")
    expect(locations).toContain("https://docs.example.com/docs/kv/configure")
    expect(locations).toContain("https://docs.example.com/tutorials")
    // `navigation: false` hides a page from the sidebar, not from crawlers.
    expect(locations).toContain("https://docs.example.com/docs/kv/draft")
    expect(locations).toContain("https://docs.example.com/a&amp;b")
  })
})

describe("llms files and MCP", () => {
  it("lists the pages under Docs, after the extra sections, with links to the raw copies", async () => {
    const response = await app.fetch(new Request("https://docs.example.com/llms.txt"))
    const text = await response.text()
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(text.startsWith("# Fixture\n\n> Fixture docs.\n\nRules for agents.\n\n## Overview\n\n- [Fixture](https://docs.example.com/raw/index.md)\n\n## Documentation Sets")).toBe(true)
    expect(text.indexOf("## Links")).toBeLessThan(text.indexOf("## Docs"))
    expect(text).toContain("](https://docs.example.com/raw/docs/kv/configure.md)")
    expect(await (await app.fetch(new Request("https://docs.example.com/sitemap.md"))).text()).toContain("](https://docs.example.com/raw/docs/kv/configure.md)")
  })

  it("joins the copies in llms-full.txt without the section links", async () => {
    const full = await (await app.fetch(new Request("https://docs.example.com/llms-full.txt"))).text()
    const copy = await copyOf("/docs/kv/configure")
    expect(full).toContain(copy.markdown)
    expect(full).not.toContain("<!-- vitehub-docs:section-links -->")
  })

  it("lists and reads pages through the MCP tools of Content", async () => {
    const pages = JSON.parse((await tool("list-pages")).content[0]!.text) as Array<{ path: string, url: string }>
    expect(pages).toContainEqual(expect.objectContaining({ path: "/docs/kv/configure", url: "https://docs.example.com/docs/kv/configure" }))
    const read = JSON.parse((await tool("get-page", { path: "/docs/kv/configure" })).content[0]!.text) as { content: string }
    expect(read.content).toBe((await copyOf("/docs/kv/configure")).markdown)
    expect((await tool("get-page", { path: "/docs/missing" })).isError).toBe(true)
  })
})

describe("docs resources below an application base", () => {
  const based = new H3()
    .get("/portal/api/_docs/page/**", page)
    .get("/portal/api/_docs/search.json", search)
    .get("/portal/raw/**", raw)
    .get("/portal/sitemap.xml", sitemap)
    .get("/portal/llms.txt", llms)

  it("serves page JSON and search while keeping page paths app-relative", async () => {
    docsConfig.appBase = "/portal/"
    const response = await based.fetch(new Request("https://docs.example.com/portal/api/_docs/page/docs/kv.json"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ page: { path: "/docs/kv" } })
    const index = await based.fetch(new Request("https://docs.example.com/portal/api/_docs/search.json"))
    expect(index.status).toBe(200)
    expect(await index.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^\/docs\/kv/) })]))
  })

  it("reads raw Markdown below the mount prefix and prefixes every public URL", async () => {
    docsConfig.appBase = "/portal/"
    const copy = await copyOf("/docs/kv", "https://docs.example.com/portal")
    const response = await based.fetch(new Request("https://docs.example.com/portal/raw/docs/kv.md"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(`${copy.markdown}${copy.footer}`)
    const xml = await based.fetch(new Request("https://docs.example.com/portal/sitemap.xml"))
    expect(await xml.text()).toContain("https://docs.example.com/portal/docs/kv")
    expect(await (await based.fetch(new Request("https://docs.example.com/portal/llms.txt"))).text()).toContain("](https://docs.example.com/portal/raw/docs/kv.md)")
  })
})
