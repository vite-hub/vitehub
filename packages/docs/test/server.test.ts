import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { H3, H3Event } from "h3"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DocsPublicConfig } from "../src/nuxt.ts"

const getItem = vi.fn<(key: string) => Promise<unknown>>()
const useStorage = vi.fn((_base: string) => ({ getItem }))
const docsConfig: Pick<DocsPublicConfig, "site" | "sitemap" | "appBase"> = {
  appBase: "/",
  site: { name: "Fixture", url: "https://docs.example.com", description: "", logo: null, badge: null },
  sitemap: ["/tutorials", "/docs/kv", "/a&b"],
}

// The handlers import Nitro auto-imports. h3 provides the same functions; storage and runtime config are fakes.
vi.mock("#imports", async () => {
  const h3 = await import("h3")
  return {
    createError: h3.createError,
    defineEventHandler: h3.defineEventHandler,
    getRequestURL: h3.getRequestURL,
    getRouterParam: h3.getRouterParam,
    setHeader: h3.setHeader,
    useStorage,
    useRuntimeConfig: () => ({ public: { docs: docsConfig } }),
  }
})
vi.mock("#docs/content", () => ({ content: undefined }))
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return { default: createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" }) }
})

const { default: raw } = await import("../src/runtime/server/raw.ts")
const { default: sitemap } = await import("../src/runtime/server/sitemap.ts")
const { default: page } = await import("../src/runtime/server/page.ts")
const { default: search } = await import("../src/runtime/server/search.ts")
const { default: source } = await import("../src/runtime/server/agent-source.ts")
const app = new H3().get("/raw/**", raw).get("/sitemap.xml", sitemap)

beforeEach(() => {
  vi.clearAllMocks()
  docsConfig.appBase = "/"
})

describe("raw Markdown route", () => {
  it.each(["# Introduction\n\nHello", ""])("returns the stored Markdown unchanged: %j", async (markdown) => {
    getItem.mockResolvedValue(markdown)
    const response = await app.fetch(new Request("https://docs.example.com/raw/docs/kv.md"))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await response.text()).toBe(markdown)
    expect(useStorage).toHaveBeenCalledWith("assets:docs-raw")
    expect(getItem).toHaveBeenCalledWith("docs/kv.md")
  })

  it("serves the home page from its own raw copy", async () => {
    getItem.mockResolvedValue("# Home\n")
    const response = await app.fetch(new Request("https://docs.example.com/raw/index.md"))

    expect(await response.text()).toBe("# Home\n")
    expect(getItem).toHaveBeenCalledWith("index.md")
  })

  it("decodes the path before it reads storage", async () => {
    getItem.mockResolvedValue("# Spaced\n")
    await app.fetch(new Request("https://docs.example.com/raw/docs/a%20b.md"))
    expect(getItem).toHaveBeenCalledWith("docs/a b.md")
  })

  it.each(["%ZZ", "%E0%A4%A"])("returns 404 for malformed escapes %s without reading storage", async (path) => {
    // Nitro 2 / H3 1 lets the malformed path reach the handler. H3 2 rejects it before routing with 400.
    const event = new H3Event(new Request(`https://docs.example.com/raw/docs/${path}.md`))
    event.context.params = { _: `docs/${path}.md` }
    await expect(raw(event)).rejects.toMatchObject({ statusCode: 404 })
    expect(getItem).not.toHaveBeenCalled()
  })

  it("returns 404 for a page without a raw copy", async () => {
    getItem.mockResolvedValue(null)
    const response = await app.fetch(new Request("https://docs.example.com/raw/missing.md"))
    expect(response.status).toBe(404)
  })

  it("rejects paths that are not Markdown without reading storage", async () => {
    const response = await app.fetch(new Request("https://docs.example.com/raw/docs/kv.html"))
    expect(response.status).toBe(404)
    expect(getItem).not.toHaveBeenCalled()
  })
})

describe("sitemap route", () => {
  it("lists every manifest page and the extra paths once, sorted, on the canonical origin", async () => {
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


describe("docs resources below an application base", () => {
  const based = new H3()
    .get("/portal/api/_docs/page/**", page)
    .get("/portal/api/_docs/search.json", search)
    .get("/portal/raw/**", raw)
    .get("/portal/sitemap.xml", sitemap)

  it("serves page JSON and search while keeping page paths app-relative", async () => {
    docsConfig.appBase = "/portal/"
    getItem.mockImplementation(async key => readFileSync(resolve(import.meta.dirname, "fixtures/content", key), "utf8"))
    const response = await based.fetch(new Request("https://docs.example.com/portal/api/_docs/page/docs/kv.json"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ page: { path: "/docs/kv" } })
    const index = await based.fetch(new Request("https://docs.example.com/portal/api/_docs/search.json"))
    expect(index.status).toBe(200)
    expect(await index.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^\/docs\/kv/) })]))
  })

  it("reads raw Markdown independently of the mount prefix and prefixes sitemap URLs", async () => {
    docsConfig.appBase = "/portal/"
    getItem.mockResolvedValue("# KV")
    const response = await based.fetch(new Request("https://docs.example.com/portal/raw/docs/kv.md"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("# KV")
    expect(getItem).toHaveBeenCalledWith("docs/kv.md")
    const xml = await based.fetch(new Request("https://docs.example.com/portal/sitemap.xml"))
    expect(await xml.text()).toContain("https://docs.example.com/portal/docs/kv")
  })

  it("lists public discovery paths and reads them back from app-relative manifest entries", async () => {
    docsConfig.appBase = "/portal/"
    expect(source.list()).toEqual(expect.arrayContaining([expect.objectContaining({ route: "/portal/docs/kv" })]))
    getItem.mockResolvedValue("# KV")
    expect(await source.get("/portal/docs/kv")).toMatchObject({ markdown: "# KV" })
    expect(getItem).toHaveBeenCalledWith("docs/kv.md")
  })
})
