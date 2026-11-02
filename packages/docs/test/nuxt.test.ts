import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { DocsModuleOptions, DocsPublicConfig } from "../src/nuxt.ts"

type Hook = (...args: never[]) => unknown
const hooks = new Map<string, Hook[]>()
const templates = new Map<string, () => string>()
const handlers: Array<{ route: string }> = []
vi.mock("@nuxt/kit", () => ({
  defineNuxtModule: (definition: { setup: unknown }) => definition.setup,
  createResolver: () => ({ resolve: (path: string) => resolve(import.meta.dirname, "../src", path) }),
  addTemplate: (template: { filename: string, getContents: () => string }) => {
    templates.set(template.filename, template.getContents)
    return { dst: `/build/${template.filename}` }
  },
  addServerHandler: (handler: { route: string }) => handlers.push(handler),
  addComponent: vi.fn(),
  addComponentsDir: vi.fn(),
  addImportsDir: vi.fn(),
  addPlugin: vi.fn(),
  addRouteMiddleware: vi.fn(),
  extendPages: vi.fn(),
  useLogger: () => ({ error: vi.fn() }),
}))
const { default: setup } = await import("../src/nuxt.ts")
const roots: string[] = []

afterEach(() => {
  hooks.clear()
  templates.clear()
  handlers.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupDocs(docs: DocsModuleOptions, appBase = "/", dev = false) {
  const buildDir = mkdtempSync(join(tmpdir(), "docs-nuxt-"))
  roots.push(buildDir)
  const options = {
    rootDir: resolve(import.meta.dirname, "fixtures"), buildDir, serverDir: "/missing-server",
    srcDir: "/app", dev, build: { transpile: [] }, appConfig: {}, _layers: [],
    app: { baseURL: appBase, head: {} }, runtimeConfig: { public: {} }, alias: {}, css: [],
    imports: { dirs: [] }, docs,
  }
  const nuxt = {
    options,
    hook: (name: string, hook: Hook) => hooks.set(name, [...hooks.get(name) ?? [], hook]),
  }
  await setup(docs, nuxt as never)
  return options as typeof options & {
    runtimeConfig: { public: { docs: DocsPublicConfig } }
    agentDiscovery: { siteUrl: string, routes: Array<string | { path: string, raw: string }>, discovery: unknown }
    llms: { domain: string }
  }
}

describe("docs Nuxt setup", () => {
  it.each(["docs", "/docs/", "/docs"])("shares the normalized base %s with the manifest and discovery", async (base) => {
    const options = await setupDocs({ base, mcp: false })
    expect(options.runtimeConfig.public.docs.base).toBe("/docs")
    expect(templates.get("docs/manifest.mjs")?.()).toContain('"base":"/docs"')
    expect(options.agentDiscovery.routes).toContain("/docs/**")
  })

  it("starts development before the content directory exists", async () => {
    await expect(setupDocs({ dir: "not-created-yet" }, "/", true)).resolves.toBeDefined()
  })

  it("keeps manifest and Nitro resources app-relative and advertises public URLs below the app base", async () => {
    const options = await setupDocs({ site: { url: "https://docs.example.com", logo: "/logo.svg" } }, "/portal/")
    expect(options.runtimeConfig.public.docs).toMatchObject({
      appBase: "/portal/", base: "/docs",
      site: { url: "https://docs.example.com", logo: "/portal/logo.svg" },
      mcp: { url: "https://docs.example.com/portal/mcp" },
    })
    expect(options.agentDiscovery.siteUrl).toBe("https://docs.example.com")
    expect(options.agentDiscovery.discovery).toMatchObject({
      links: [{ href: "https://docs.example.com/portal/sitemap.xml" }],
      mcpServerCard: { endpoint: "https://docs.example.com/portal/mcp" },
    })
    expect(options.agentDiscovery.routes).toEqual(expect.arrayContaining([
      { path: "/docs/kv", raw: "/portal/raw/docs/kv.md" },
      { path: "/portal/docs/kv", raw: "/portal/raw/docs/kv.md" },
    ]))
    const nitro = {
      runtimeConfig: {
        agentDiscovery: { links: [{ href: "/llms.txt", anchor: "/" }, { href: "/.well-known/skills/index.json" }] },
        public: { agentDiscovery: { resources: [{ href: "/sitemap.md" }] } },
      },
      routeRules: { "/": { headers: { Link: '</llms.txt>; rel="describedby"' } } },
      prerender: { routes: ["/blog"] },
    }
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never)
    expect(nitro.runtimeConfig.agentDiscovery.links[0]).toEqual({ href: "/portal/llms.txt", anchor: "/portal/" })
    expect(nitro.runtimeConfig.agentDiscovery.links[1]?.href).toBe("/portal/.well-known/skills/index.json")
    expect(nitro.runtimeConfig.public.agentDiscovery.resources[0]?.href).toBe("/portal/sitemap.md")
    expect(nitro.routeRules["/"].headers.Link).toBe('</portal/llms.txt>; rel="describedby"')
    expect(options.llms.domain).toBe("https://docs.example.com/portal")
    const routes = nitro.prerender.routes
    expect(routes).toEqual(expect.arrayContaining(["/blog", "/docs/kv", "/api/_docs/page/docs/kv.json", "/api/_docs/search.json", "/sitemap.xml"]))
    expect(routes.some(path => path.startsWith("/portal"))).toBe(false)
    expect(handlers.map(handler => handler.route)).toEqual(["/api/_docs/page/**", "/api/_docs/search.json", "/sitemap.xml", "/raw/**"])
  })
})
