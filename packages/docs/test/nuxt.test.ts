import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import { github } from "@vite-hub/source"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"

import type { DocsPackedFiles } from "../src/files.ts"
import type { DocsModuleOptions, DocsPublicConfig } from "../src/nuxt.ts"
import { docsAgentCopy } from "../src/agent-copy.ts"
import { createDocsManifest } from "../src/manifest.ts"
import { findDocsPage } from "../src/navigation.ts"

type Hook = (...args: never[]) => unknown
const hooks = new Map<string, Hook[]>()
const templates = new Map<string, () => string>()
const handlers: Array<{ route: string, method?: string }> = []
let templateDir = "/build"
const updateTemplates = vi.hoisted(() => vi.fn<(options: { filter: (template: { filename: string }) => boolean }) => Promise<void>>())
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock("@nuxt/kit", () => ({
  defineNuxtModule: (definition: { setup: object, moduleDependencies: unknown }) => Object.assign(definition.setup, { moduleDependencies: definition.moduleDependencies }),
  createResolver: () => ({ resolve: (path: string) => resolve(import.meta.dirname, "../src", path) }),
  addTemplate: (template: { filename: string, getContents: () => string }) => {
    templates.set(template.filename, template.getContents)
    return { dst: join(templateDir, template.filename) }
  },
  addTypeTemplate: (template: { filename: string, getContents: () => string }) => {
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
  useLogger: () => logger,
  updateTemplates,
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
const { extendPages } = await import("@nuxt/kit")
// SAFETY: the @nuxt/kit mock above keeps the module definition's moduleDependencies on the setup function.
const moduleDependencies = (setup as unknown as { moduleDependencies: (nuxt: unknown) => Promise<Record<string, unknown>> }).moduleDependencies
const roots: string[] = []

/** The manifest that the generated `docs/manifest.mjs` exports. */
function manifestTemplate(): unknown {
  const source = templates.get("docs/manifest.mjs")?.() ?? ""
  return JSON.parse(JSON.parse(source.replace(/^export default JSON\.parse\(/, "").replace(/\)\s*$/, "")))
}

afterEach(async () => {
  for (const hook of hooks.get("close") ?? []) await hook()
  vi.useRealTimers()
  watchContent.mockClear()
  updateTemplates.mockReset()
  hooks.clear()
  templates.clear()
  handlers.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupDocs(docs: DocsModuleOptions, appBase = "/", dev = false, layers: Array<{ config: Record<string, unknown> }> = []) {
  const buildDir = mkdtempSync(join(tmpdir(), "docs-nuxt-"))
  templateDir = buildDir
  roots.push(buildDir)
  const options = {
    rootDir: resolve(import.meta.dirname, "fixtures"), buildDir, serverDir: "/missing-server",
    // A Nuxt 5 nightly installs as `nuxt-nightly`.
    srcDir: "/app", appDir: "/node_modules/nuxt-nightly/dist/app", dev, build: { transpile: [] }, appConfig: {}, extensions: [".js", ".ts", ".vue"], _layers: layers,
    experimental: { defaults: { nuxtLink: { prefetchOn: { visibility: true } as Record<string, boolean> } } },
    app: { baseURL: appBase, head: {} }, runtimeConfig: { public: {} }, alias: {}, css: [],
    imports: { dirs: [] }, watch: [] as string[], docs,
  }
  const nuxt = {
    options,
    callHook: vi.fn(async () => {}),
    hook: (name: string, hook: Hook) => hooks.set(name, [...hooks.get(name) ?? [], hook]),
  }
  await setup(docs, nuxt as never)
  return options as typeof options & {
    runtimeConfig: { public: { docs: DocsPublicConfig } }
    agentDiscovery: { siteUrl: string, source: string | false, routes: Array<string | { path: string, raw: string }>, discovery: unknown }
  }
}

/** A content folder with only these pages, and an app folder with an `app.vue` when `ownApp` is set. */
function appWithDocs(files: Record<string, string>, ownApp = false) {
  const root = mkdtempSync(join(tmpdir(), "docs-app-"))
  roots.push(root)
  for (const [file, title] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "content", file)), { recursive: true })
    writeFileSync(join(root, "content", file), `---\ntitle: ${title}\n---\n`)
  }
  mkdirSync(join(root, "app"))
  if (ownApp) writeFileSync(join(root, "app/app.vue"), "<template><UApp><NuxtLayout><NuxtPage /></NuxtLayout></UApp></template>\n")
  return { dir: join(root, "content"), srcDir: join(root, "app") }
}

async function callHook(name: string, ...args: unknown[]) {
  for (const hook of hooks.get(name) ?? []) await (hook as (...args: unknown[]) => unknown)(...args)
}

describe("docs in an existing app", () => {
  it("serves the content folder's docs/ folder at /docs, and a folder without one at the site root", async () => {
    const app = appWithDocs({ "docs/guide/index.md": "Guide" })
    expect((await setupDocs({ dir: app.dir })).runtimeConfig.public.docs.base).toBe("/docs")
    const site = appWithDocs({ "index.md": "Home", "guide/index.md": "Guide" })
    expect((await setupDocs({ dir: site.dir })).runtimeConfig.public.docs.base).toBe("/")
    // The manifest template is `export default JSON.parse("...")`.
    expect(JSON.parse(JSON.parse(/JSON\.parse\((".*")\)/s.exec(templates.get("docs/manifest.mjs")!())![1]!)).base).toBe("/")
    expect((await setupDocs({ dir: site.dir, base: "/docs" })).runtimeConfig.public.docs.base).toBe("/docs")
  })

  it("answers only below /docs, beside the app's own catch-all page", async () => {
    const app = appWithDocs({ "docs/index.md": "Docs", "docs/guide/index.md": "Guide" })
    await setupDocs({ dir: app.dir })
    const extend = vi.mocked(extendPages).mock.calls.at(-1)![0] as (pages: Array<{ path: string, name?: string }>) => void
    const pages = [{ path: "/" }, { path: "/:slug(.*)*" }]
    extend(pages)
    expect(pages.at(-1)).toMatchObject({ name: "docs-page", path: "/docs/:slug(.*)*" })
    const replaced = [{ path: "/docs/:slug(.*)*" }]
    extend(replaced)
    expect(replaced).toHaveLength(1)
  })

  it("answers every path when a page sits outside the docs base", async () => {
    await setupDocs({})
    const extend = vi.mocked(extendPages).mock.calls.at(-1)![0] as (pages: Array<{ path: string, name?: string }>) => void
    const pages: Array<{ path: string, name?: string }> = []
    extend(pages)
    expect(pages).toMatchObject([{ name: "docs-page", path: "/:slug(.*)*" }])
  })

  it("keeps the app's head, layouts, and home page when the app has its own app.vue", async () => {
    const app = appWithDocs({ "docs/guide/index.md": "Guide" }, true)
    const options = await setupDocs({ dir: app.dir }, "/", false, [{ config: { srcDir: app.srcDir } }]) as Awaited<ReturnType<typeof setupDocs>> & { app: { head: Record<string, unknown> } }
    expect(options.app.head).toEqual({})
    expect(templates.get("docs/shell.mjs")?.()).toBe("export const ownsApp = false\n")
    // The app config keeps the app's colors and slot classes. The docs layouts scope the theme with <UTheme>.
    expect(options.appConfig).toEqual({ ui: { prose: { codeIcon: expect.any(Object) } } })
    expect(templates.get("docs/theme.mjs")?.()).toContain('"pageHeader":{')
    const css = templates.get("docs/theme.css")!()
    expect(templates.get("docs/docs.css")!()).toContain(`${options.buildDir}/docs/theme.css`)
    expect(css).toContain("html:where(.vh-docs)")
    expect(css).toContain(":root:where(.vh-docs).dark")
    expect(css).toContain(":where(.vh-docs) :focus-visible")
    expect(css).not.toContain("@theme")
    expect(css).not.toContain("--ui-primary:")
    const layouts: Record<string, { file: string }> = {}
    await callHook("app:templates", { layouts, templates: [] })
    expect(Object.keys(layouts).sort()).toEqual(["docs", "docs-article"])
    const appFile = join(app.srcDir, "app.vue")
    const resolved = { mainComponent: appFile, errorComponent: `${options.appDir}/components/nuxt-error-page.vue` }
    await callHook("app:resolve", resolved)
    expect(resolved.mainComponent).toBe(appFile)
    expect(resolved.errorComponent).toBe(`${options.appDir}/components/nuxt-error-page.vue`)
    expect(options.agentDiscovery.routes).not.toContain("/")
  })

  it("draws the site with the docs app.vue when the app has none", async () => {
    const options = await setupDocs({}) as Awaited<ReturnType<typeof setupDocs>> & { app: { head: { titleTemplate?: string, htmlAttrs?: { class?: string } } } }
    expect(options.app.head.titleTemplate).toBe("%s · Docs")
    expect(options.app.head.htmlAttrs?.class).toBe("vh-docs")
    expect(options.appConfig).toMatchObject({ ui: { colors: { primary: "neutral", neutral: "neutral" } } })
    expect(templates.get("docs/theme.mjs")?.()).toBe('export default {"ui":{},"props":{}}\n')
    expect(templates.has("docs/theme.css")).toBe(false)
    expect(templates.get("docs/shell.mjs")?.()).toBe("export const ownsApp = true\n")
    const layouts: Record<string, { file: string }> = {}
    await callHook("app:templates", { layouts, templates: [] })
    expect(Object.keys(layouts).sort()).toEqual(["default", "docs"])
    // Nuxt's pages module turns the welcome page into its own app.vue before the docs module sees it.
    const resolved = { mainComponent: resolve(options.appDir, "../pages/runtime/app.vue"), errorComponent: `${options.appDir}/components/nuxt-error-page.vue` }
    await callHook("app:resolve", resolved)
    expect(resolved.mainComponent).toMatch(/runtime\/app\/app\.vue$/)
    expect(resolved.errorComponent).toMatch(/runtime\/app\/error\.vue$/)
  })

  it.each([false, true])("builds docs classes in the app's Tailwind build, with mapped sources: %s", async (mapped) => {
    const app = appWithDocs({ "docs/guide/index.md": "Guide" })
    writeFileSync(join(app.srcDir, "main.css"), '@import "tailwindcss";\n@import "@nuxt/ui";\n')
    const options = await setupDocs(mapped ? { sources: [app.dir] } : { dir: app.dir }) as Awaited<ReturnType<typeof setupDocs>> & { css: string[], alias: Record<string, string> }
    const docsCss = templates.get("docs/docs.css")!
    expect(docsCss()).toMatch(/@import "\/.+\/tailwindcss\/index\.css";/)
    options.alias["~"] = app.srcDir
    options.css.push("~/main.css")
    expect(docsCss()).not.toContain("tailwindcss")
    expect(docsCss()).toContain("theme/design.css")
    const ui = { filename: "ui.css", getContents: async () => '@source "/app/**/*";' }
    await callHook("app:templates", { layouts: {}, templates: [ui] })
    const contents = await ui.getContents()
    expect(contents).toContain('@source "/app/**/*";')
    expect(contents).toContain(`@source "${app.dir}";`)
    expect(contents).toMatch(/@source ".*runtime\/app";/)
  })

  it("keeps the docs Tailwind imports when regenerating its own stylesheet", async () => {
    const options = await setupDocs({})
    const docsCss = templates.get("docs/docs.css")!
    const file = options.css[0]!
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, docsCss())

    // Absolute files, so they resolve from a template outside the app and in an app that lists neither package.
    expect(docsCss()).toMatch(/@import "\/.+\/tailwindcss\/index\.css";/)
    expect(docsCss()).toMatch(/@import "\/.+\/@nuxt\/ui\/dist\/runtime\/index\.css";/)
    for (const [, file] of docsCss().matchAll(/@import "([^"]+(?:tailwindcss|@nuxt\/ui)[^"]+)";/g)) expect(existsSync(file!)).toBe(true)
  })

  it("lets docs pages link to the app's own pages, which the build does not prerender", async () => {
    const app = appWithDocs({ "docs/guide/index.md": "Guide" })
    const options = await setupDocs({ dir: app.dir })
    const publicDir = join(options.buildDir, "public")
    mkdirSync(join(publicDir, "docs/guide"), { recursive: true })
    writeFileSync(join(publicDir, "docs/guide.html"), `<a href="/">Home</a><a href="/pricing">Pricing</a>`)
    const compiled: Array<() => void> = []
    await callHook("nitro:init", { options: { output: { publicDir } }, hooks: { hook: (_name: "compiled", callback: () => void) => compiled.push(callback) } })
    expect(() => compiled[0]!()).not.toThrow()
    writeFileSync(join(publicDir, "docs/guide.html"), `<a href="/docs/missing">Missing</a><a href="/raw/docs/missing.md">Raw</a>`)
    expect(() => compiled[0]!()).toThrow(/\/docs\/missing, which has no page or file[\s\S]*\/raw\/docs\/missing\.md/)
  })

  it("prerenders the docs pages of an app without crawling the app's own pages", async () => {
    const app = appWithDocs({ "docs/guide/index.md": "Guide" })
    await setupDocs({ dir: app.dir })
    const nitro: { prerender?: { crawlLinks?: boolean, routes?: string[] } } = {}
    await callHook("nitro:config", nitro)
    expect(nitro.prerender).toMatchObject({ crawlLinks: false, routes: expect.arrayContaining(["/docs/guide", "/api/_docs/page/docs/guide.json"]) })
    hooks.clear()
    await setupDocs({})
    const site: typeof nitro = {}
    await callHook("nitro:config", site)
    expect(site.prerender?.crawlLinks).toBe(true)
  })
})

describe("docs Nuxt setup", () => {
  it.each(["/", "/portal/"])("accepts validated redirect links in the compiled output under %s", async (appBase) => {
    const options = await setupDocs({}, appBase)
    Object.assign(options, { linkChecker: { excludeLinks: ["/badge.svg"] } })
    const publicDir = join(options.buildDir, "public")
    mkdirSync(publicDir)
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}docs/old">Old</a><a href="${appBase}mcp">MCP</a><img src="/badge.svg">`)
    const compiled: Array<() => void> = []
    const nitro = {
      options: {
        routeRules: { "/docs/old": { redirect: "/docs/start" } },
        output: { publicDir },
      },
      hooks: { hook: (name: string, callback: () => void) => name === "compiled" && compiled.push(callback) },
    }
    for (const hook of hooks.get("nitro:init") ?? []) await hook(nitro as never)
    expect(compiled).toHaveLength(1)
    expect(() => compiled[0]!()).not.toThrow()
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}docs/missing">Missing</a>`)
    expect(() => compiled[0]!()).toThrow(/no page or file/)
  })

  it("writes the comark-ui stylesheet again after a build empties the build directory", async () => {
    const options = await setupDocs({})
    const stylesDir = join(options.buildDir, "docs/styles")
    const [file] = readdirSync(stylesDir)
    expect(file).toMatch(/^comark-[0-9a-f]{10}\.css$/)
    rmSync(join(options.buildDir, "docs"), { recursive: true, force: true })
    for (const hook of hooks.get("build:before") ?? []) await hook()
    expect(readdirSync(stylesDir)).toEqual([file])
  })

  it("prefetches a link when the reader points at it or focuses it, not when it scrolls into view", async () => {
    const options = await setupDocs({})
    expect(options.experimental.defaults.nuxtLink.prefetchOn).toEqual({ visibility: false, interaction: true })
  })

  it("keeps the app's own choice of when links prefetch", async () => {
    const prefetchOn = { visibility: true }
    const options = await setupDocs({}, "/", false, [{ config: { srcDir: "/app", experimental: { defaults: { nuxtLink: { prefetchOn } } } } }])
    expect(options.experimental.defaults.nuxtLink.prefetchOn).toEqual(prefetchOn)
  })

  it("links the comark-ui stylesheet at runtime, below the base of the running server", async () => {
    const options = await setupDocs({})
    const [file] = readdirSync(join(options.buildDir, "docs/styles"))
    expect(templates.get("docs/comark-css.mjs")?.()).toBe(`export default ${JSON.stringify(file)}\n`)
    expect(JSON.stringify(options.app.head)).not.toContain("/_docs/")
  })

  it("reports a link to the MCP endpoint when the site turns MCP off", async () => {
    const options = await setupDocs({ mcp: false })
    const publicDir = join(options.buildDir, "public")
    mkdirSync(publicDir)
    writeFileSync(join(publicDir, "index.html"), `<a href="/mcp">MCP</a>`)
    const compiled: Array<() => void> = []
    const nitro = { options: { routeRules: {}, output: { publicDir } }, hooks: { hook: (_name: "compiled", callback: () => void) => compiled.push(callback) } }
    for (const hook of hooks.get("nitro:init") ?? []) await hook(nitro as never)
    expect(() => compiled[0]!()).toThrow(/\/mcp, which has no page or file/)
  })

  it.each(["/", "/portal/"])("combines Docs and app link exclusions in the compiled output under %s", async (appBase) => {
    const options = await setupDocs({ linkChecker: { excludeLinks: [`${appBase}blog/**`, new RegExp(`^${appBase}media/`)] } }, appBase)
    Object.assign(options, { linkChecker: { excludeLinks: [`${appBase}badge.svg`] } })
    const publicDir = join(options.buildDir, "public")
    mkdirSync(publicDir)
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}blog/post">Post</a><img src="${appBase}media/icon.svg"><img src="${appBase}badge.svg">`)
    const compiled: Array<() => void> = []
    const nitro = { options: { output: { publicDir } }, hooks: { hook: (_name: "compiled", callback: () => void) => compiled.push(callback) } }
    for (const hook of hooks.get("nitro:init") ?? []) await hook(nitro as never)
    expect(() => compiled[0]!()).not.toThrow()
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}missing">Missing</a>`)
    expect(() => compiled[0]!()).toThrow(/no page or file/)
  })

  it.each(["/", "/portal/"])("accepts server-rendered and Console links using Nitro's prerender policy under %s", async (appBase) => {
    const options = await setupDocs({}, appBase)
    const publicDir = join(options.buildDir, "public")
    mkdirSync(publicDir)
    const paths = ["blog", "blog/post", "changelog", "media/illustrations/edit-this-site-dark.svg", "feed.xml", "api/time", "dynamic/page", "_vitehub", "_vitehub/sign-in", "_vitehub/content", "_vitehub/comments"]
    writeFileSync(join(publicDir, "index.html"), paths.map(path => `<a href="${appBase}${path}#intro">${path}</a>`).join(""))
    const compiled: Array<() => void> = []
    const nitro = {
      options: {
        output: { publicDir },
        routeRules: { "/blog/**": { prerender: false, swr: 60 }, "/blog/static": { prerender: true }, "/dynamic/:slug": { prerender: false } },
        prerender: { ignore: ["/changelog", "/media/**", /^\/feed\./g, (path: string) => path === "/api/time", "/_vitehub", `${appBase}_vitehub`] },
      },
      hooks: { hook: (name: string, callback: () => void) => name === "compiled" && compiled.push(callback) },
    }
    for (const hook of hooks.get("nitro:init") ?? []) await hook(nitro as never)
    expect(() => compiled[0]!()).not.toThrow()
    for (const path of ["blog/static", "blogger", "missing"]) {
      writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}${path}">Missing</a>`)
      expect(() => compiled[0]!()).toThrow(`links to ${appBase}${path}, which has no page or file`)
    }
    // An output file still provides fragment evidence, even for an otherwise dynamic route.
    writeFileSync(join(publicDir, "changelog.html"), '<h2 id="intro">Changes</h2>')
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}changelog#missing">Missing fragment</a>`)
    expect(() => compiled[0]!()).toThrow('no element with id "missing"')
    // Console paths must have a serving policy; disabling the Console must not mask a broken link.
    nitro.options.prerender.ignore = []
    writeFileSync(join(publicDir, "index.html"), `<a href="${appBase}_vitehub">Console</a>`)
    expect(() => compiled[0]!()).toThrow(/_vitehub, which has no page or file/)
  })

  it("registers source assets, writes raw copies from the right directory and loads configured components", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-sources-"));
    roots.push(dir);
    for (const name of ["a", "b"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "index.md"), `---\ntitle: ${name}\n---\nSource ${name}`);
    }
    const options = await setupDocs(
      {
        base: "/",
        sources: [
          { source: join(dir, "a"), mount: "/a" },
          { source: join(dir, "b"), mount: "/b" },
        ],
        components: "./markdown-components.ts",
      },
      "/",
      true,
    );
    const nitro: { serverAssets?: unknown[] } = {};
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never);
    expect(nitro.serverAssets).toEqual(
      expect.arrayContaining([
        { baseName: "docs-0", dir: join(dir, "a"), pattern: "**/*.md" },
        { baseName: "docs-1", dir: join(dir, "b"), pattern: "**/*.md" },
      ]),
    );
    expect(nitro.serverAssets).toEqual(expect.arrayContaining([{ baseName: "docs-agent", dir: join(options.buildDir, "docs/agent"), pattern: "**/*.md" }]));
    expect(templates.get("docs/custom-components.mjs")?.()).toContain("markdown-components.ts");
    expect(watchContent.mock.calls.map((call) => call[0])).toEqual([
      join(dir, "a"),
      join(dir, "b"),
    ]);
  });

  it.each([true, false])("copies and serves the pages of a github() Source (dev: %s)", async (dev) => {
    const fake = createFakeGitHub({ owner: "acme", repo: "docs" });
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token");
    vi.stubEnv("FORGES_GITHUB_TOKEN", "");
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    fake.commit("main", {
      "docs/guide/start.md": "---\ntitle: Start\n---\nFrom a Source",
      "docs/draft.md": "---\ntitle: Draft\n---\n",
    });
    const options = await setupDocs(
      {
        base: "/",
        sources: [{ source: github({ repo: "acme/docs", root: "docs" }), mount: "/remote", exclude: ["draft.md"] }],
        rawMarkdown: markdown => `${markdown}\nRewritten.`,
      },
      "/",
      dev,
    );
    const copied = join(options.buildDir, "docs/sources/docs-0");
    expect(readFileSync(join(copied, "guide/start.md"), "utf8")).toBe("---\ntitle: Start\n---\nFrom a Source");
    expect(existsSync(join(copied, "draft.md"))).toBe(false);
    const nitro: { serverAssets?: unknown[], virtual?: Record<string, string | (() => string)> } = {};
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never);
    if (dev) expect(nitro.serverAssets).toContainEqual({ baseName: "docs-0", dir: copied, pattern: "**/*.md" });
    else expect(nitro.serverAssets ?? []).toEqual([]);
    // `nuxi build` empties the build folder after the modules load, so the copy is written again before the build.
    rmSync(join(options.buildDir, "docs"), { recursive: true, force: true });
    for (const hook of hooks.get("build:before") ?? []) await hook();
    expect(readFileSync(join(copied, "guide/start.md"), "utf8")).toContain("From a Source");
    expect(readFileSync(join(options.buildDir, "docs/agent/docs_0/guide/start.md"), "utf8")).toContain("Rewritten.");
    if (!dev) {
      const template = nitro.virtual?.["#docs/files"];
      if (typeof template !== "function") throw new Error("#docs/files is not generated");
      const { default: files } = await import(`data:text/javascript,${encodeURIComponent(template())}`) as { default: DocsPackedFiles };
      expect(files.index["docs-0"]?.["guide/start.md"]).toBeDefined();
      expect(files.index["docs-0"]?.["draft.md"]).toBeUndefined();
      expect(files.index["docs-agent"]?.["docs_0/guide/start.md"]).toBeDefined();
    }
    // Content renders the raw copy on request, so the build writes none.
    expect(existsSync(join(options.buildDir, "docs/raw"))).toBe(false);
    // A Source has no folder to watch.
    expect(watchContent).not.toHaveBeenCalled();
  });

  it("packs the pages and rewritten agent copies of a build into one module instead of a server asset per file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-packed-"));
    roots.push(dir);
    for (const name of ["a", "b"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "index.md"), `---\ntitle: ${name}\n---\nSource ${name}`);
    }
    await setupDocs({ base: "/", sources: [{ source: join(dir, "a"), mount: "/a" }, { source: join(dir, "b"), mount: "/b" }], rawMarkdown: markdown => `${markdown}\nRewritten.` });
    const nitro: { serverAssets?: Array<{ baseName: string }>, virtual?: Record<string, string | (() => string)> } = {};
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never);
    expect(nitro.serverAssets?.filter(asset => asset.baseName.startsWith("docs")) ?? []).toEqual([]);
    for (const hook of hooks.get("build:before") ?? []) await hook();
    const template = nitro.virtual?.["#docs/files"];
    if (typeof template !== "function") throw new Error("#docs/files is not generated at build time");
    const { default: files } = await import(`data:text/javascript,${encodeURIComponent(template())}`) as { default: DocsPackedFiles };
    vi.doMock("#docs/files", () => ({ default: files }));
    vi.doMock("nitro/kv", () => ({ useKV: () => { throw new Error("A build must not read server assets") } }));
    vi.resetModules();
    const { readDocsFile } = await import("../src/runtime/files.ts");
    expect(await readDocsFile("docs-0", "index.md")).toBe("---\ntitle: a\n---\nSource a");
    expect(await readDocsFile("docs-1", "index.md")).toBe("---\ntitle: b\n---\nSource b");
    expect(await readDocsFile("docs-agent", "docs_1/index.md")).toContain("Source b");
    for (const [store, file] of [["docs-0", "missing.md"], ["docs-agent", "constructor"], ["__proto__", "index.md"], ["docs-agent", "../a/index.md"]]) {
      expect(await readDocsFile(store!, file!)).toBeNull();
    }
    // Each page sits next to its rewritten agent copy in the packed bytes.
    expect(files.index["docs-0"]!["index.md"]![1]).toBe(files.index["docs-agent"]!["docs_0/index.md"]![0]);
    vi.doUnmock("#docs/files");
    vi.doUnmock("nitro/kv");
  });

  it.each(["docs", "/docs/", "/docs"])("shares the normalized base %s with the manifest and discovery", async (base) => {
    const options = await setupDocs({ base, mcp: false })
    expect(options.runtimeConfig.public.docs.base).toBe("/docs")
    expect(templates.get("docs/manifest.mjs")?.()).toMatch(/^export default JSON\.parse\(/)
    expect(templates.get("docs/manifest.d.ts")?.()).toContain("declare const manifest: DocsManifest\n")
    expect(templates.get("types/vite-hub-docs.d.ts")?.()).toContain("interface PublicRuntimeConfig { docs: DocsPublicConfig }")
    expect(manifestTemplate()).toMatchObject({ base: "/docs" })
    expect(options.agentDiscovery.routes).toContain("/docs/**")
  })

  it("replaces Nuxt's own welcome and error pages, and keeps the app's", async () => {
    await setupDocs({})
    const resolveApp = hooks.get("app:resolve")![0] as (app: { mainComponent: string, errorComponent: string }) => void
    const defaults = { mainComponent: "/node_modules/nuxt-nightly/dist/app/components/welcome.vue", errorComponent: "/node_modules/nuxt-nightly/dist/app/components/nuxt-error-page.vue" }
    resolveApp(defaults)
    expect(defaults.mainComponent).toMatch(/runtime\/app\/app\.vue$/)
    expect(defaults.errorComponent).toMatch(/runtime\/app\/error\.vue$/)
    const template = { mainComponent: "/node_modules/@nuxt/ui-templates/templates/dashboard/app.vue", errorComponent: "/app/error.vue" }
    resolveApp(template)
    expect(template.mainComponent).toMatch(/runtime\/app\/app\.vue$/)
    expect(template.errorComponent).toBe("/app/error.vue")
    const own = { mainComponent: "/app/app.vue", errorComponent: "/app/error.vue" }
    resolveApp(own)
    expect(own).toEqual({ mainComponent: "/app/app.vue", errorComponent: "/app/error.vue" })
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
    // The manifest reads the files through Content, so the run ends after real I/O, not after a timer.
    await vi.waitFor(() => expect(templates.get("docs/manifest.mjs")?.()).toContain("First page"))
    expect(options.buildDir).toBeTruthy()
  })

  it.each([false, true])(
    "serializes raw transformations across edits, multiple sources: %s",
    async (multiple) => {
      vi.useFakeTimers();
      const content = mkdtempSync(join(tmpdir(), "docs-edits-"));
      roots.push(content);
      mkdirSync(join(content, "docs"));
      const page = join(content, "docs/index.md");
      writeFileSync(page, "---\ntitle: Page\n---\n# Original");
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Only a page that the transform changes is kept for the server.
      const transform = vi.fn(async (source: string) => {
        if (source.includes("Older")) await blocked;
        return `${source}\nFor agents.`;
      });
      const second = join(content, "other");
      mkdirSync(second);
      writeFileSync(join(second, "index.md"), "---\ntitle: Other\n---\n# Original");
      const options = await setupDocs(
        {
          dir: content,
          ...(multiple
            ? {
                sources: [
                  { source: join(content, "docs"), mount: "/docs" },
                  { source: second, mount: "/other" },
                ],
              }
            : {}),
          rawMarkdown: transform,
        },
        "/",
        true,
      );
      const changed = watchContent.mock.calls[0]![2]!;
      const changedSecond = multiple ? watchContent.mock.calls[1]![2]! : changed;
      writeFileSync(page, "---\ntitle: Page\n---\n# Older");
      changed("change", multiple ? "index.md" : "docs/index.md");
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(transform).toHaveBeenCalledTimes(1));
      writeFileSync(multiple ? join(second, "index.md") : page, "---\ntitle: Page\n---\n# Newer");
      changedSecond("change", multiple ? "index.md" : "docs/index.md");
      await vi.advanceTimersByTimeAsync(100);
      const concurrent = transform.mock.calls.length;
      release();
      expect(concurrent).toBe(1);
      await vi.waitFor(() => expect(
        readFileSync(
          join(options.buildDir, multiple ? "docs/agent/docs_1/index.md" : "docs/agent/docs_0/docs/index.md"),
          "utf8",
        ),
      ).toContain("Newer"));
    },
  );

  it("gives the page route and search the app's parser module", async () => {
    const options = await setupDocs({ parser: "./docs.parser.ts" })
    expect(templates.get("docs/parser.mjs")?.()).toBe(`export { default } from ${JSON.stringify(resolve(options.rootDir, "docs.parser.ts"))}\nexport const githubRepo = null\n`)
    const nitro: { alias?: Record<string, string> } = {}
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never)
    expect(nitro.alias?.["#docs/parser"]).toBe(join(options.buildDir, "docs/parser.mjs"))
  })

  it("loads each Vue file of the examples folder in the page and gives its source to the parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-examples-"))
    writeFileSync(join(dir, "ButtonExample.vue"), "<template><UButton /></template>\n")
    writeFileSync(join(dir, "notes.md"), "Not an example.\n")
    const options = await setupDocs({ examples: dir })
    expect(options.watch).not.toContain(dir)
    const nitro: { alias?: Record<string, string> } = {}
    for (const hook of hooks.get("nitro:config") ?? []) await hook(nitro as never)

    expect(templates.get("docs/examples.mjs")?.()).toBe(`export default {\n  "ButtonExample": () => import(${JSON.stringify(join(dir, "ButtonExample.vue"))}),\n}\n`)
    expect(templates.get("docs/example-sources.mjs")?.()).toBe(`export default {"ButtonExample":"<template><UButton /></template>\\n"}\n`)
    expect(nitro.alias?.["#docs/example-sources"]).toBe(join(options.buildDir, "docs/example-sources.mjs"))
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(["absolute", "relative"])("watches external examples and refreshes both maps on %s events", async (pathKind) => {
    const dir = mkdtempSync(join(tmpdir(), "docs-examples-watch-"))
    roots.push(dir)
    const file = join(dir, "ButtonExample.vue")
    const options = await setupDocs({ examples: dir }, "/", true)
    expect(options.watch).toContain(dir)

    const generated = new Map<string, string>()
    updateTemplates.mockImplementation(async ({ filter }) => {
      for (const [filename, contents] of templates) {
        if (filter({ filename })) generated.set(filename, contents())
      }
    })
    const notify = async (event: string) => {
      const path = pathKind === "absolute" ? file : relative(options.srcDir, file)
      for (const hook of hooks.get("builder:watch") ?? []) await hook(event as never, path as never)
    }

    for (const [event, source] of [["add", "<template>First</template>"], ["change", "<template>Edited</template>"]] as const) {
      writeFileSync(file, source)
      await notify(event)
      expect(generated.get("docs/examples.mjs")).toContain(JSON.stringify(file))
      expect(generated.get("docs/example-sources.mjs")).toBe(`export default ${JSON.stringify({ ButtonExample: source })}\n`)
    }
    rmSync(file)
    await notify("unlink")
    expect(generated.get("docs/examples.mjs")).toBe("export default {\n\n}\n")
    expect(generated.get("docs/example-sources.mjs")).toBe("export default {}\n")
  })

  it("parses with the built-in plugins only without a parser module", async () => {
    await setupDocs({})
    expect(templates.get("docs/parser.mjs")?.()).toBe("export default {}\nexport const githubRepo = null\n")
  })

  it("gives the parser the site's repository, where issue references link", async () => {
    await setupDocs({ github: { repo: "vite-hub/vitehub" } })
    expect(templates.get("docs/parser.mjs")?.()).toContain(`export const githubRepo = "vite-hub/vitehub"`)
  })

  it("writes relative Markdown links against the rendered page below the app base", async () => {
    const content = mkdtempSync(join(tmpdir(), "docs-links-"))
    roots.push(content)
    mkdirSync(join(content, "docs/guide"), { recursive: true })
    writeFileSync(join(content, "docs/guide/current.md"), "---\ntitle: Current\n---\n[Next](./next)")
    const manifest = await createDocsManifest({ dir: content, base: "/docs" })
    const copy = docsAgentCopy(manifest, findDocsPage(manifest, "/docs/guide/current")!.page, readFileSync(join(content, "docs/guide/current.md"), "utf8"), "https://docs.example.com/portal")
    expect(copy.markdown).toContain("[Next](https://docs.example.com/portal/docs/guide/next)")
    expect(copy.footer).toBe("\n<!-- vitehub-docs:section-links -->\nAll pages: [llms.txt](https://docs.example.com/portal/llms.txt)\n")
  })

  it("shows a colored logo as it is, with its dark version", async () => {
    const options = await setupDocs({ site: { logo: { light: "/logo.svg", dark: "/logo-dark.svg" } } }, "/portal/")
    expect(options.runtimeConfig.public.docs.site.logo).toEqual({ src: "/portal/logo.svg", dark: "/portal/logo-dark.svg", mask: false })
  })

  it("keeps manifest and Nitro resources app-relative and advertises public URLs below the app base", async () => {
    const options = await setupDocs({ site: { url: "https://docs.example.com", logo: "/logo.svg" } }, "/portal/")
    expect(options.runtimeConfig.public.docs).toMatchObject({
      appBase: "/portal/", base: "/docs",
      site: { url: "https://docs.example.com", logo: { src: "/portal/logo.svg", dark: null, mask: true } },
      mcp: { url: "https://docs.example.com/portal/mcp" },
    })
    expect(options.agentDiscovery.siteUrl).toBe("https://docs.example.com")
    // Content serves the copies, so nuxt-agent-discovery only negotiates to them.
    expect(options.agentDiscovery.source).toBe(false)
    expect(options.agentDiscovery.discovery).toMatchObject({
      links: [{ href: "/sitemap.md" }, { href: "/llms.txt" }, { href: "/llms.txt", anchor: "/" }, { href: "/llms-full.txt" }, { href: "/llms-full.txt", anchor: "/" }, { href: "https://docs.example.com/portal/sitemap.xml" }],
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
    const routes = nitro.prerender.routes
    expect(routes).toEqual(expect.arrayContaining(["/blog", "/docs/kv", "/api/_docs/page/docs/kv.json", "/api/_docs/search.json", "/sitemap.xml", "/raw/docs/kv.md", "/sitemap.md", "/llms.txt", "/llms-full.txt"]))
    expect(routes.some(path => path.startsWith("/portal"))).toBe(false)
    expect(handlers.map(handler => handler.route)).toEqual([
      "/api/_docs/page/**", "/api/_docs/search.json", "/sitemap.xml",
      "/llms.txt", "/llms-full.txt", "/sitemap.md",
      "/llms.txt", "/llms-full.txt", "/sitemap.md",
      "/mcp",
    ])
    // Nitro gets the raw route directly, so nuxt-agent-discovery still lets the build prerender the copies.
    expect((nitro as { handlers?: Array<{ route: string, method: string }> }).handlers?.map(handler => [handler.route, handler.method])).toEqual([["/raw/**", "get"], ["/raw/**", "head"]])
  })
})

describe("docs search checks", () => {
  /** Runs the prerender hooks that the docs module adds to Nitro over these routes. */
  async function prerender(docs: DocsModuleOptions, routes: Array<{ route: string, contents: string }>, appBase = "/") {
    hooks.clear()
    await setupDocs(docs, appBase)
    const nitroHooks = new Map<string, Hook[]>()
    const nitro = { options: {}, hooks: { hook: (name: string, hook: Hook) => nitroHooks.set(name, [...nitroHooks.get(name) ?? [], hook]) } }
    for (const hook of hooks.get("nitro:init") ?? []) await hook(nitro as never)
    for (const { route, contents } of routes) {
      const html = route.endsWith(".xml") ? {} : { fileName: `${route}.html`, contentType: "text/html;charset=utf-8" }
      for (const hook of nitroHooks.get("prerender:generate") ?? []) await hook({ route, contents, ...html } as never)
    }
    for (const hook of nitroHooks.get("prerender:done") ?? []) await hook()
    return nitroHooks
  }
  const routes = [
    { route: "/sitemap.xml", contents: "<urlset><url><loc>http://docs.invalid/guides</loc></url></urlset>" },
    { route: "/guides", contents: "<html><head><meta http-equiv=\"refresh\" content=\"0; url=/learn\"></head><body></body></html>" },
  ]

  it.each(["error", true] as const)("stops the build on a page that fails a check when seoAudit is %s", async (seoAudit) => {
    await expect(prerender({ seoAudit }, routes)).rejects.toMatchObject({
      name: "DocsSeoError",
      problems: ["/guides is in the sitemap, but it redirects. List the page that it redirects to instead."],
    })
  })

  it.each([undefined, "warn"] as const)("logs the problems and keeps building when seoAudit is %s", async (seoAudit) => {
    logger.warn.mockClear()
    await prerender({ seoAudit }, routes)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("/guides is in the sitemap, but it redirects."))
  })

  it("adds no prerender hooks when seoAudit is false", async () => {
    expect([...(await prerender({ seoAudit: false }, routes)).keys()].filter(name => name.startsWith("prerender:"))).toEqual([])
  })

  it.each(["/", "/portal/"])("audits ordinary pages without site.url under %s", async (appBase) => {
    const pages = ["guides", "learn"].map((name, index, names) => ({
      route: `/${name}`,
      contents: `<html><head><title>Docs ${name} overview</title>
        <meta name="description" content="Read the ${name} overview for practical steps to build, configure, and publish your documentation site.">
        <link rel="canonical" href="http://docs.invalid${appBase}${name}"></head>
        <body><h1>${name}</h1><p>${"Useful documentation content. ".repeat(60)}</p>
        <a href="${appBase}${names[1 - index]}">Related page</a></body></html>`,
    }))
    await expect(prerender({ seoAudit: "error" }, [
      ...pages,
      { route: "/sitemap.xml", contents: `<urlset>${pages.map(page => `<url><loc>http://docs.invalid${appBase}${page.route.slice(1)}</loc></url>`).join("")}</urlset>` },
    ], appBase)).resolves.toBeInstanceOf(Map)
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

  it("turns Comments off with comments: false in the docs key or the inline options", async () => {
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
