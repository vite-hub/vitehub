import { resolve } from "node:path"

import { H3 } from "h3"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DocsPublicConfig } from "../src/nuxt.ts"

const getItem = vi.fn<(key: string) => Promise<unknown>>()
const useStorage = vi.fn((_base: string) => ({ getItem }))
const docsConfig: Pick<DocsPublicConfig, "site" | "sitemap"> = {
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
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return { default: createDocsManifest({ dir: resolve(import.meta.dirname, "fixtures/content"), base: "/docs" }) }
})

const { default: raw } = await import("../src/runtime/server/raw.ts")
const { default: sitemap } = await import("../src/runtime/server/sitemap.ts")
const app = new H3().get("/raw/**", raw).get("/sitemap.xml", sitemap)

beforeEach(() => vi.clearAllMocks())

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
