import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { defineSitemap } from "../src/seo.ts"
import { defineRobotsRoute, defineSitemapRoute } from "../src/seo/runtime.ts"
import { isSitemapPage, nitroSitemapPages, viteHubSeoPlugin } from "../src/seo/vite.ts"

import type { SeoContent } from "../src/seo/runtime.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-seo-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  return root
}

function content(overrides: Partial<SeoContent> = {}): SeoContent {
  return {
    seo: {},
    sitemap: async ({ site }) => [{ loc: `${site}/blog/hello`, lastmod: "2026-11-01T00:00:00.000Z" }],
    ...overrides,
  }
}

async function sitemapOf(route: { fetch(request: Request): Promise<Response> }, url = "https://shop.example.com/sitemap.xml"): Promise<string> {
  const response = await route.fetch(new Request(url))
  expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8")
  return await response.text()
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!)
}

describe("/sitemap.xml", () => {
  it("lists the static pages, the Content pages, and the server/sitemap.ts entries once, sorted by URL", async () => {
    const route = defineSitemapRoute({
      site: "https://shop.example.com",
      base: "/",
      pages: ["/", "/about", "/blog/hello"],
      exclude: [],
      content: async () => content(),
      app: async () => defineSitemap(async () => [
        { loc: "/products/kettle", lastmod: new Date("2026-11-10T00:00:00Z") },
        { loc: "https://cdn.example.com/catalog" },
      ]),
    })
    const xml = await sitemapOf(route)
    expect(locs(xml)).toEqual([
      "https://cdn.example.com/catalog",
      "https://shop.example.com/",
      "https://shop.example.com/about",
      "https://shop.example.com/blog/hello",
      "https://shop.example.com/products/kettle",
    ])
    // The Content page keeps its date, though the static page came first.
    expect(xml).toContain("<loc>https://shop.example.com/blog/hello</loc>\n    <lastmod>2026-11-01T00:00:00.000Z</lastmod>")
    expect(xml).toContain("<lastmod>2026-11-10T00:00:00.000Z</lastmod>")
  })

  it("uses the request origin when the build has no site, and puts the app base before each path", async () => {
    const route = defineSitemapRoute({ site: null, base: "/shop/", pages: ["/cart"], exclude: [], app: async () => [{ loc: "/products/kettle" }] })
    expect(locs(await sitemapOf(route, "http://localhost:3000/shop/sitemap.xml"))).toEqual(["http://localhost:3000/shop/cart", "http://localhost:3000/shop/products/kettle"])
  })

  it("leaves out the excluded path prefixes from every source", async () => {
    const route = defineSitemapRoute({
      site: "https://shop.example.com",
      base: "/",
      pages: ["/admin", "/admin/users", "/administrators", "/about"],
      exclude: ["/admin"],
      content: async () => content({ sitemap: async ({ site }) => [{ loc: `${site}/admin/guide` }] }),
      app: async () => [{ loc: "/admin/orders" }],
    })
    expect(locs(await sitemapOf(route))).toEqual(["https://shop.example.com/about", "https://shop.example.com/administrators"])
  })

  it("lists Content pages only when a reader without a user may read them", async () => {
    const pages = async (overrides: Partial<SeoContent>) => locs(await sitemapOf(defineSitemapRoute({ site: "https://shop.example.com", base: "/", pages: [], exclude: [], content: async () => content(overrides) })))
    expect(await pages({ hasPolicy: true, can: async () => false })).toEqual([])
    expect(await pages({ hasPolicy: true, can: async ({ user }) => user === null })).toEqual(["https://shop.example.com/blog/hello"])
    expect(await pages({ hasPolicy: true, access: "public", can: async () => false })).toEqual(["https://shop.example.com/blog/hello"])
    expect(await pages({ seo: { sitemap: false } })).toEqual([])
  })

  it("fails with SEO_SITEMAP_ENTRY_INVALID for an entry that is not a page", async () => {
    for (const entry of [{ loc: "products/kettle" }, { loc: "//evil.example.com/" }, { loc: "https://" }, { loc: "https://not a host" }, { loc: "/a", lastmod: "not a date" }]) {
      const route = defineSitemapRoute({ site: "https://shop.example.com", base: "/", pages: [], exclude: [], app: async () => [entry] })
      await expect(route.fetch(new Request("https://shop.example.com/sitemap.xml"))).rejects.toMatchObject({ code: "SEO_SITEMAP_ENTRY_INVALID" })
    }
  })

  it("fails with SEO_SITEMAP_TOO_LARGE above 50,000 URLs", async () => {
    const entries = Array.from({ length: 50_001 }, (_, index) => ({ loc: `/products/${index}` }))
    const route = defineSitemapRoute({ site: "https://shop.example.com", base: "/", pages: [], exclude: [], app: async () => entries })
    await expect(route.fetch(new Request("https://shop.example.com/sitemap.xml"))).rejects.toMatchObject({ code: "SEO_SITEMAP_TOO_LARGE" })
  })
})

describe("/robots.txt", () => {
  it("allows crawling and names the sitemap, with the Content disallow paths", async () => {
    const plain = await defineRobotsRoute({ site: "https://shop.example.com" }).fetch(new Request("http://localhost/robots.txt"))
    expect(await plain.text()).toBe("User-agent: *\nAllow: /\n\nSitemap: https://shop.example.com/sitemap.xml\n")
    const withContent = await defineRobotsRoute({ site: null, content: async () => content({ seo: { robots: { disallow: ["/_vitehub"] } } }) }).fetch(new Request("http://localhost:3000/robots.txt"))
    expect(await withContent.text()).toBe("User-agent: *\nDisallow: /_vitehub\n\nSitemap: http://localhost:3000/sitemap.xml\n")
  })
})

describe("static pages", () => {
  it("keeps only pages without a dynamic part, a file extension, or a server path", () => {
    expect(["/", "/about", "/blog/hello", "/products/:slug", "/docs/**", "/[...slug]", "/feed.xml", "/api/orders", "/_vitehub/rpc", "/apidocs"].filter(isSitemapPage))
      .toEqual(["/", "/about", "/blog/hello", "/apidocs"])
  })

  it("reads the prerender routes and the static prerender route rules of Nitro", () => {
    expect(nitroSitemapPages({
      prerender: { routes: ["/", "/sitemap.xml", "/pricing"] },
      routeRules: { "/about": { prerender: true }, "/blog/**": { prerender: true }, "/admin": { prerender: false } },
    })).toEqual(["/", "/pricing", "/about"])
  })
})

describe("vitehub({ seo: { sitemap } }) plugin", () => {
  async function configure(root: string, command: "build" | "serve", publicUrl?: string, nitro: Record<string, unknown> = {}) {
    const plugin = viteHubSeoPlugin({ sitemap: { exclude: ["/admin/"] } }, publicUrl)
    const config: Record<string, unknown> = { root, nitro }
    const hook = plugin.config as (config: Record<string, unknown>, env: { command: string, mode: string }) => Promise<void>
    await hook(config, { command, mode: command === "build" ? "production" : "development" })
    return { plugin, config }
  }

  it("generates /sitemap.xml with the site, the pages, server/sitemap.ts, and Content, and /robots.txt", async () => {
    const root = await project({
      "server/sitemap.ts": "export default []\n",
      "server/content.ts": "export default {}\n",
    })
    const { plugin, config } = await configure(root, "build", "https://shop.example.com")
    await plugin.nitro.setup({ options: { prerender: { routes: ["/pricing"] } }, hooks: { hook: () => {} } })
    await plugin.api.setPages(["/", "/products/:slug"])
    expect((config.nitro as { handlers: unknown[] }).handlers).toEqual([
      { handler: join(root, ".vitehub/nitro/seo/sitemap.mjs"), method: "get", route: "/sitemap.xml" },
      { handler: join(root, ".vitehub/nitro/seo/robots.mjs"), method: "get", route: "/robots.txt" },
    ])
    const sitemap = await readFile(join(root, ".vitehub/nitro/seo/sitemap.mjs"), "utf8")
    expect(sitemap).toContain(`site: "https://shop.example.com", base: "/", pages, exclude: ["/admin"]`)
    expect(sitemap).toContain(`app: () => import(${JSON.stringify(pathToFileURL(join(root, "server/sitemap.ts")).href)})`)
    expect(sitemap).toContain(`content: () => import(${JSON.stringify(pathToFileURL(join(root, "server/content.ts")).href)})`)
    expect(await readFile(join(root, ".vitehub/nitro/seo/pages.mjs"), "utf8")).toBe(`export default ["/","/pricing"]\n`)
  })

  it("uses the request origin in development, and fails a build without publicUrl with SEO_PUBLIC_URL_MISSING", async () => {
    const root = await project({})
    await configure(root, "serve")
    expect(await readFile(join(root, ".vitehub/nitro/seo/sitemap.mjs"), "utf8")).toContain("site: null")
    await expect(configure(root, "build")).rejects.toMatchObject({ code: "SEO_PUBLIC_URL_MISSING" })
  })

  it("leaves robots.txt to the app when it has one", async () => {
    for (const file of ["public/robots.txt", "server/routes/robots.txt.ts", "server/routes/robots.txt.get.ts"]) {
      const root = await project({ [file]: "" })
      const { config } = await configure(root, "serve")
      expect((config.nitro as { handlers: Array<{ route: string }> }).handlers.map(handler => handler.route)).toEqual(["/sitemap.xml"])
    }
  })

  it("fails the build with SEO_SITEMAP_ROUTE_EXISTS when the app has its own /sitemap.xml route", async () => {
    const root = await project({})
    const { plugin } = await configure(root, "serve")
    let buildBefore: (() => void) | undefined
    await plugin.nitro.setup({ options: {}, hooks: { hook: (_name, callback) => { buildBefore = callback } }, scannedHandlers: [{ route: "/sitemap.xml" }] })
    expect(() => buildBefore?.()).toThrow(expect.objectContaining({ code: "SEO_SITEMAP_ROUTE_EXISTS" }))
  })
})
