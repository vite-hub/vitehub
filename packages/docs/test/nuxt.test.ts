import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { DocsModuleOptions, DocsPublicConfig } from "../src/nuxt.ts"

type Hook = (...args: never[]) => unknown
const hooks = new Map<string, Hook[]>()
const templates = new Map<string, () => string>()
const handlers: Array<{ route: string, method?: string }> = []
vi.mock("@nuxt/kit", () => ({
  defineNuxtModule: (definition: { setup: object, moduleDependencies: unknown }) => Object.assign(definition.setup, { moduleDependencies: definition.moduleDependencies }),
  createResolver: () => ({ resolve: (path: string) => resolve(import.meta.dirname, "../src", path) }),
  addTemplate: (template: { filename: string, getContents: () => string }) => {
    templates.set(template.filename, template.getContents)
    return { dst: `/build/${template.filename}` }
  },
  addServerHandler: (handler: { route: string, method?: string }) => handlers.push(handler),
  addComponent: vi.fn(),
  addComponentsDir: vi.fn(),
  addImportsDir: vi.fn(),
  addPlugin: vi.fn(),
  addRouteMiddleware: vi.fn(),
  extendPages: vi.fn(),
  useLogger: () => ({ error: vi.fn() }),
}))
const watchContent = vi.hoisted(() => vi.fn((_dir: string, _options: { recursive: boolean }, _listener: (event: string, file: string | null) => void) => ({ close: vi.fn() })))
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  watch: watchContent,
}))
// The test runner resolves workspace packages from anywhere, so resolve only from the app's own node_modules.
vi.mock("node:module", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:module")>(),
  createRequire: (from: string) => ({
    resolve: (id: string) => {
      const file = join(dirname(from), "node_modules", id)
      if (existsSync(file)) return file
      throw new Error(`Cannot find module '${id}'`)
    },
  }),
}))
const { default: setup, DocsCommentsSetupError } = await import("../src/nuxt.ts")
// SAFETY: the @nuxt/kit mock above keeps the module definition's moduleDependencies on the setup function.
const moduleDependencies = (setup as unknown as { moduleDependencies: (nuxt: unknown) => Promise<Record<string, unknown>> }).moduleDependencies
const roots: string[] = []

afterEach(async () => {
  for (const hook of hooks.get("close") ?? []) await hook()
  vi.useRealTimers()
  watchContent.mockClear()
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
    callHook: vi.fn(async () => {}),
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

  it("observes the first pages when a missing content directory is created", async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), "docs-new-content-"))
    roots.push(root)
    const content = join(root, "nested/content")
    const options = await setupDocs({ dir: content }, "/", true)
    expect(watchContent).toHaveBeenCalledWith(root, { recursive: true }, expect.any(Function))
    mkdirSync(join(content, "docs"), { recursive: true })
    writeFileSync(join(content, "docs/index.md"), "---\ntitle: First page\n---\n# First page")
    const changed = watchContent.mock.calls.at(-1)![2]!
    changed("rename", "nested")
    await vi.advanceTimersByTimeAsync(100)
    expect(templates.get("docs/manifest.mjs")?.()).toContain("First page")
    expect(readFileSync(join(options.buildDir, "docs/raw/docs.md"), "utf8")).toContain("First page")
  })

  it("serializes raw transformations across edits", async () => {
    vi.useFakeTimers()
    const content = mkdtempSync(join(tmpdir(), "docs-edits-"))
    roots.push(content)
    mkdirSync(join(content, "docs"))
    const page = join(content, "docs/index.md")
    writeFileSync(page, "---\ntitle: Page\n---\n# Original")
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const transform = vi.fn(async (source: string) => {
      if (source.includes("Older")) await blocked
      return source
    })
    const options = await setupDocs({ dir: content, rawMarkdown: transform }, "/", true)
    const changed = watchContent.mock.calls.at(-1)![2]!
    writeFileSync(page, "---\ntitle: Page\n---\n# Older")
    changed("change", "docs/index.md")
    await vi.advanceTimersByTimeAsync(100)
    expect(transform).toHaveBeenCalledTimes(1)
    writeFileSync(page, "---\ntitle: Page\n---\n# Newer")
    changed("change", "docs/index.md")
    await vi.advanceTimersByTimeAsync(100)
    const concurrent = transform.mock.calls.length
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(concurrent).toBe(1)
    expect(readFileSync(join(options.buildDir, "docs/raw/docs.md"), "utf8")).toContain("Newer")
  })

  it("gives the page route and search the app's parser module", async () => {
    const options = await setupDocs({ parser: "./docs.parser.ts" })
    expect(templates.get("docs/parser.mjs")?.()).toBe(`export { default } from ${JSON.stringify(resolve(options.rootDir, "docs.parser.ts"))}\n`)
    const nitro: { alias?: Record<string, string> } = {}
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never)
    expect(nitro.alias?.["#docs/parser"]).toBe("/build/docs/parser.mjs")
  })

  it("parses with the built-in plugins only without a parser module", async () => {
    await setupDocs({})
    expect(templates.get("docs/parser.mjs")?.()).toBe("export default {}\n")
  })

  it("writes relative Markdown links against the rendered page below the app base", async () => {
    const content = mkdtempSync(join(tmpdir(), "docs-links-"))
    roots.push(content)
    mkdirSync(join(content, "docs/guide"), { recursive: true })
    writeFileSync(join(content, "docs/guide/current.md"), "---\ntitle: Current\n---\n[Next](./next)")
    const options = await setupDocs({ dir: content, site: { url: "https://docs.example.com" } }, "/portal/")
    for (const hook of hooks.get("build:before") ?? []) await hook()
    const raw = readFileSync(join(options.buildDir, "docs/raw/docs/guide/current.md"), "utf8")
    expect(raw).toContain("[Next](https://docs.example.com/portal/docs/guide/next)")
    expect(raw.endsWith("\n\n<!-- vitehub-docs:section-links -->\nAll pages: [llms.txt](https://docs.example.com/portal/llms.txt)\n")).toBe(true)
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
    expect(handlers.map(handler => handler.route)).toEqual(["/api/_docs/page/**", "/api/_docs/search.json", "/sitemap.xml", "/raw/**", "/raw/**"])
    expect(handlers.filter(handler => handler.route === "/raw/**").map(handler => handler.method)).toEqual(["get", "head"])
  })
})

describe("docs Comments", () => {
  /** A Nuxt app with these modules, `docs` options, and `@vite-hub/comments` installed unless `comments` is false. */
  function app(modules: unknown[], docs?: DocsModuleOptions, comments = true) {
    const rootDir = mkdtempSync(join(tmpdir(), "docs-comments-"))
    roots.push(rootDir)
    writeFileSync(join(rootDir, "package.json"), "{}\n")
    if (comments) {
      mkdirSync(join(rootDir, "node_modules/@vite-hub/comments"), { recursive: true })
      writeFileSync(join(rootDir, "node_modules/@vite-hub/comments/package.json"), JSON.stringify({ name: "@vite-hub/comments", exports: { "./package.json": "./package.json" } }))
    }
    return { options: { rootDir, modules, ...(docs ? { docs } : {}) } }
  }
  const docsModule = Object.assign(() => undefined, { getMeta: async () => ({ name: "@vite-hub/docs" }) })

  it("installs the link checker, failing the build on a broken link, unless linkChecker is false", async () => {
    const dependencies = await moduleDependencies(app(["@vite-hub/docs/nuxt"], undefined, false))
    const [name, options] = Object.entries(dependencies).find(([key]) => key.includes("nuxt-link-checker")) ?? []
    expect(name).toBeDefined()
    expect(options).toEqual({ defaults: { failOnError: true, fetchRemoteUrls: false, showLiveInspections: false } })
    expect(Object.keys(await moduleDependencies(app(["@vite-hub/docs/nuxt"], { linkChecker: false }, false))).some(key => key.includes("nuxt-link-checker"))).toBe(false)
  })

  it("turns Comments on in vite-hub/nuxt by default", async () => {
    const dependencies = await moduleDependencies(app(["vite-hub/nuxt", "@vite-hub/docs/nuxt"]))
    expect(dependencies["vite-hub/nuxt"]).toEqual({ optional: true, defaults: { comments: true } })
  })

  it("passes comments options to vite-hub/nuxt", async () => {
    const dependencies = await moduleDependencies(app(["vite-hub/nuxt", [docsModule, { comments: { database: "docs", overlay: false } }]]))
    expect(dependencies["vite-hub/nuxt"]).toEqual({ optional: true, defaults: { comments: { database: "docs", overlay: false } } })
  })

  it("turns Comments off, also the Console's default, with comments: false in the docs key or the inline options", async () => {
    const off = { optional: true, defaults: { comments: false } }
    expect((await moduleDependencies(app(["vite-hub/nuxt", "@vite-hub/docs/nuxt"], { comments: false })))["vite-hub/nuxt"]).toEqual(off)
    expect((await moduleDependencies(app(["vite-hub/nuxt", [docsModule, { comments: false }]])))["vite-hub/nuxt"]).toEqual(off)
    expect(await moduleDependencies(app(["@vite-hub/docs/nuxt"], { comments: false }))).not.toHaveProperty("vite-hub/nuxt")
  })

  it("has no Comments without vite-hub/nuxt, and fails the build when docs asks for them", async () => {
    expect(await moduleDependencies(app(["@vite-hub/docs/nuxt"]))).not.toHaveProperty("vite-hub/nuxt")
    await expect(moduleDependencies(app(["@vite-hub/docs/nuxt"], { comments: true }))).rejects.toThrow(DocsCommentsSetupError)
  })

  it("requires an installed module even when the vitehub config key exists", async () => {
    const nuxt = app(["@vite-hub/docs/nuxt"])
    Object.assign(nuxt.options, { vitehub: { comments: true } })
    expect(await moduleDependencies(nuxt)).not.toHaveProperty("vite-hub/nuxt")
    for (const comments of [true, { overlay: false }] as const) {
      Object.assign(nuxt.options, { docs: { comments } })
      await expect(moduleDependencies(nuxt)).rejects.toThrow(/docs.comments needs vite-hub\/nuxt/)
    }
  })

  it("honors the app's Comments opt-out before checking the package or Database", async () => {
    const nuxt = app(["vite-hub/nuxt"], undefined, false)
    Object.assign(nuxt.options, { vitehub: { comments: false, database: false } })
    expect(await moduleDependencies(nuxt)).not.toHaveProperty("vite-hub/nuxt")
    expect(await moduleDependencies(app([["vite-hub/nuxt", { comments: false, database: false }]], { comments: true }, false))).not.toHaveProperty("vite-hub/nuxt")
    nuxt.options.modules = [["vite-hub/nuxt", { comments: true }]]
    await expect(moduleDependencies(nuxt)).rejects.toThrow(/pnpm add @vite-hub\/comments/)
  })

  it("names the package or the opt-out when Comments cannot run", async () => {
    await expect(moduleDependencies(app(["vite-hub/nuxt"], undefined, false))).rejects.toThrow(/pnpm add @vite-hub\/comments.*docs: \{ comments: false \}/)
    await expect(moduleDependencies(app([["vite-hub/nuxt", { database: false }]]))).rejects.toThrow(/Remove database: false, or set docs: \{ comments: false \}/)
  })
})
