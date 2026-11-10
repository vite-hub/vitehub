import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { bundleCliContributor } from "../src/cli.ts"
import { collectEnvironmentReport } from "../src/collect.ts"
import { readEnvironmentReports, writeEnvironmentReport } from "../src/files.ts"
import { createBundleReport, explainBundleRoute } from "../src/report.ts"
import { matchRoute, nuxtPageRoutes } from "../src/routes.ts"
import { hubBundle } from "../src/vite.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ModuleInfoLike, OutputChunkLike } from "../src/collect.ts"

const root = "/app"
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-routes-"))
  dirs.push(dir)
  return dir
}

function chunk(fileName: string, code: string, modules: string[], options: { entry?: boolean, imports?: string[], css?: string[] } = {}): OutputChunkLike {
  return {
    type: "chunk",
    fileName,
    code,
    isEntry: Boolean(options.entry),
    facadeModuleId: options.entry ? modules[0]! : null,
    imports: options.imports ?? [],
    modules: Object.fromEntries(modules.map(id => [id, { renderedLength: 10 }])),
    ...(options.css ? { viteMetadata: { importedCss: new Set(options.css) } } : {}),
  }
}

const noGraph = (entry: string) => (id: string): ModuleInfoLike => ({ importedIds: [], dynamicallyImportedIds: [], isEntry: id === entry })

/** A Nuxt client build: one entry, a default layout, a docs parent page, and pages that share a chunk. */
function clientReport() {
  const entry = `${root}/node_modules/nuxt/dist/app/entry.js`
  return collectEnvironmentReport({
    "_nuxt/entry.js": chunk("_nuxt/entry.js", "e".repeat(1000), [entry, `${root}/app/app.vue`, `${root}/app/pages/docs/[slug].vue?macro=true`], { entry: true, imports: ["_nuxt/vue.js"], css: ["_nuxt/entry.css"] }),
    "_nuxt/vue.js": chunk("_nuxt/vue.js", "v".repeat(500), [`${root}/node_modules/vue/dist/vue.mjs`]),
    "_nuxt/default.js": chunk("_nuxt/default.js", "l".repeat(50), [`${root}/app/layouts/default.vue`], { imports: ["_nuxt/vue.js"] }),
    "_nuxt/docs.js": chunk("_nuxt/docs.js", "d".repeat(100), [`${root}/app/pages/docs.vue`], { imports: ["_nuxt/vue.js"] }),
    "_nuxt/slug.js": chunk("_nuxt/slug.js", "s".repeat(200), [`${root}/app/pages/docs/[slug].vue`], { imports: ["_nuxt/shared.js"], css: ["_nuxt/slug.css"] }),
    "_nuxt/shared.js": chunk("_nuxt/shared.js", "h".repeat(300), [`${root}/app/components/Code.vue`, `${root}/node_modules/shiki/index.js`]),
    "_nuxt/index.js": chunk("_nuxt/index.js", "i".repeat(20), [`${root}/app/pages/index.vue`]),
    "_nuxt/lazy.js": chunk("_nuxt/lazy.js", "z".repeat(4000), [`${root}/app/components/Chart.vue`]),
    "_nuxt/entry.css": { type: "asset", fileName: "_nuxt/entry.css", source: "body{}".repeat(10) },
    "_nuxt/slug.css": { type: "asset", fileName: "_nuxt/slug.css", source: new TextEncoder().encode(".code{}") },
  }, {
    build: "b", environment: "client", side: "client", root, outDir: `${root}/.nuxt/dist/client`, getModuleInfo: noGraph(entry),
    routes: nuxtPageRoutes([
      { path: "/", file: `${root}/app/pages/index.vue`, meta: { layout: false } },
      { path: "/docs", file: `${root}/app/pages/docs.vue`, children: [{ path: ":slug()", file: `${root}/app/pages/docs/[slug].vue` }] },
    ], { default: { file: `${root}/app/layouts/default.vue` } }),
  })
}

describe("Nuxt pages", () => {
  it("preserves string and array aliases, including children of aliased parents", () => {
    const routes = nuxtPageRoutes([
      { path: "/docs", alias: "/guide", file: "docs.vue", children: [
        { path: ":slug()", alias: ["topic/:slug()", "/topics/:slug()"], file: "slug.vue" },
      ] },
      { path: "/about", alias: ["/company", "/info"], file: "about.vue" },
    ])
    for (const path of ["/docs/kv", "/guide/kv", "/docs/topic/kv", "/guide/topic/kv", "/topics/kv"]) {
      expect(matchRoute(routes, path)?.files).toEqual(["docs.vue", "slug.vue"])
    }
    for (const path of ["/about", "/company", "/info"]) expect(matchRoute(routes, path)?.files).toEqual(["about.vue"])
  })

  it("uses router sensitivity, strict slashes, regex syntax, and ranking", () => {
    const options = { sensitive: true, strict: true }
    expect(matchRoute([{ path: "/Docs" }], "/docs", options)).toBeUndefined()
    expect(matchRoute([{ path: "/Docs" }], "/Docs/", options)).toBeUndefined()
    expect(matchRoute([{ path: "/Docs/" }], "/Docs/", options)?.path).toBe("/Docs/")
    expect(matchRoute([{ path: "/Docs" }], "/docs/", { sensitive: false, strict: false })?.path).toBe("/Docs")
    const custom = String.raw`/:custom(something-(nested|other\))`
    expect(matchRoute([{ path: custom }], "/something-nested")?.path).toBe(custom)
    expect(matchRoute([{ path: custom }], "/something-other")?.path).toBe(custom)
    expect(matchRoute([{ path: custom }], "/something-else")).toBeUndefined()
    expect(matchRoute([{ path: "/:id" }, { path: String.raw`/:id(\d+)` }], "/42")?.path).toBe(String.raw`/:id(\d+)`)
  })

  it("joins nested paths, renders parents, and picks the layout from static page meta", () => {
    const routes = nuxtPageRoutes([
      { path: "/", file: "/app/pages/index.vue" },
      { path: "/plain", file: "/app/pages/plain.vue", meta: { layout: false } },
      {
        path: "/docs",
        file: "/app/pages/docs.vue",
        meta: { layout: "wide" },
        children: [
          { path: "", file: "/app/pages/docs/index.vue" },
          { path: ":slug()", components: { default: "/app/pages/docs/[slug].vue", aside: "/app/pages/docs/[slug]@aside.vue" } },
        ],
      },
      { path: "/settings", file: "/app/pages/settings.vue", children: [{ path: "profile", file: "/app/pages/settings/profile.vue", meta: { layout: "missing" } }] },
      { path: "/old" },
    ], { default: { file: "/app/layouts/default.vue" }, wide: { file: "/app/layouts/wide.vue" } })
    expect(routes).toEqual([
      { path: "/", files: ["/app/layouts/default.vue", "/app/pages/index.vue"] },
      { path: "/docs", files: ["/app/layouts/wide.vue", "/app/pages/docs.vue", "/app/pages/docs/index.vue"] },
      { path: "/docs/:slug()", files: ["/app/layouts/wide.vue", "/app/pages/docs.vue", "/app/pages/docs/[slug].vue", "/app/pages/docs/[slug]@aside.vue"] },
      { path: "/plain", files: ["/app/pages/plain.vue"] },
      { path: "/settings", files: ["/app/layouts/default.vue", "/app/pages/settings.vue"] },
      { path: "/settings/profile", files: ["/app/pages/settings.vue", "/app/pages/settings/profile.vue"] },
    ])
  })

  it.each([
    ["/docs/kv", "/docs/kv"],
    ["/docs/queue", "/docs/:slug()"],
    ["/DOCS/Queue/", "/docs/:slug()"],
    ["/docs/kv?tab=api#top", "/docs/kv"],
    ["/users", "/users/:id?"],
    ["/users/7", "/users/:id?"],
    ["/blog/2026/hello", "/blog/:parts+"],
    ["/a/b/c", "/:all(.*)*"],
    ["/", "/"],
  ])("matches %s to %s", (target, expected) => {
    const routes = ["/", "/docs/kv", "/docs/:slug()", "/users/:id?", "/blog/:parts+", "/:all(.*)*"].map(path => ({ path }))
    expect(matchRoute(routes, target)?.path).toBe(expected)
  })
})

describe("route report", () => {
  it("imports the built report exports without Vue or Vue Router runtime peers", () => {
    const entries = ["index", "cli", "vite"].map(entry => new URL(`../dist/${entry}.js`, import.meta.url).href)
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { registerHooks } from "node:module"
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (/^(vue|vue-router)(\\/|$)/.test(specifier)) throw new Error("Unexpected runtime peer: " + specifier)
        return nextResolve(specifier, context)
      } })
      for (const entry of ${JSON.stringify(entries)}) await import(entry)
    `])
  })

  it.each([
    { path: "/old", alias: "/previous", file: "/app/pages/old.vue", redirect: "/new" },
    { path: "/parent", children: [{ path: "old", file: "/app/pages/old.vue", meta: { redirect: { path: "/new" } } }] },
  ])("makes route estimates unavailable for page redirects", (page) => {
    const report = collectEnvironmentReport({}, {
      build: "test", environment: "client", side: "client", root, outDir: `${root}/dist`,
      getModuleInfo: () => null,
      routes: nuxtPageRoutes([page, { path: "/new", file: "/app/pages/new.vue" }]),
    })
    expect(report.routes).toBeUndefined()
    expect(createBundleReport([report])?.client?.routesUnavailable).toContain("Page redirects")
    expect(explainBundleRoute([report], "/old")).toBeUndefined()
  })

  it.each([false, true])("counts layouts only when the route loads NuxtLayout (renderer loaded: %s)", (usesLayout) => {
    const entry = `${root}/entry.js`
    const page = `${root}/app/pages/index.vue`
    const layout = `${root}/app/layouts/default.vue`
    const renderer = `${root}/node_modules/nuxt/dist/app/components/nuxt-layout.js`
    const report = collectEnvironmentReport({
      "entry.js": chunk("entry.js", "entry", [entry], { entry: true, imports: usesLayout ? ["renderer.js"] : [] }),
      "page.js": chunk("page.js", "page", [page]),
      "layout.js": chunk("layout.js", "layout", [layout]),
      // An emitted renderer that the route never imports must not imply a rendered layout.
      "renderer.js": chunk("renderer.js", "renderer", [renderer]),
    }, {
      build: "test", environment: "client", side: "client", root, outDir: `${root}/dist`, getModuleInfo: noGraph(entry),
      routes: nuxtPageRoutes([{ path: "/", file: page }], { default: { file: layout } }, renderer),
    })
    const route = createBundleReport([report])!.client!.routes![0]!
    expect(route.files.some(file => file.file === "layout.js")).toBe(usesLayout)
    expect(route.components.includes("app/layouts/default.vue")).toBe(usesLayout)
    expect(route.bytes).toBe(usesLayout ? 23 : 9)
  })

  it("gives aliases the same files and bytes as the canonical route", () => {
    const report = clientReport()
    const canonical = report.routes!.find(route => route.path === "/docs/:slug()")!
    report.routes = nuxtPageRoutes([{ path: "/docs", alias: "/guide", children: [
      { path: ":slug()", alias: ["topic/:slug()", "/topics/:slug()"], file: "slug.vue" },
    ] }]).map(route => ({ path: route.path, components: canonical.components }))
    const expected = explainBundleRoute([report], "/docs/kv")!.route
    for (const path of ["/guide/kv", "/docs/topic/kv", "/guide/topic/kv", "/topics/kv"]) {
      const actual = explainBundleRoute([report], path)!.route
      expect({ ...actual, path: expected.path }).toEqual(expected)
    }
  })

  it("persists matching options and suppresses routes when runtime options can replace them", () => {
    const entry = `${root}/entry.js`
    const collect = (routeOptions: { sensitive?: boolean, strict?: boolean, unavailable?: string }) => collectEnvironmentReport({
      "entry.js": chunk("entry.js", "entry", [entry], { entry: true }),
    }, {
      build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`, getModuleInfo: noGraph(entry),
      routes: [{ path: "/Docs", files: [entry] }], routeOptions,
    })
    const report = collect({ sensitive: true, strict: true })
    expect(report.routeOptions).toEqual({ sensitive: true, strict: true })
    expect(explainBundleRoute([report], "/Docs")).toBeDefined()
    expect(explainBundleRoute([report], "/docs")).toBeUndefined()
    expect(explainBundleRoute([report], "/Docs/")).toBeUndefined()
    const unavailable = "Custom router options can replace routes."
    const suppressed = collect({ unavailable })
    expect(suppressed.routes).toBeUndefined()
    expect(createBundleReport([suppressed])?.client).toMatchObject({ routesUnavailable: unavailable })
    expect(explainBundleRoute([suppressed], "/Docs")).toBeUndefined()
  })

  it("stores the routes with module ids and the CSS files of the client", () => {
    const report = clientReport()
    expect(report.routes).toEqual([
      { path: "/", components: ["app/pages/index.vue"] },
      { path: "/docs", components: ["app/layouts/default.vue", "app/pages/docs.vue"] },
      { path: "/docs/:slug()", components: ["app/layouts/default.vue", "app/pages/docs.vue", "app/pages/docs/[slug].vue"] },
    ])
    expect(report.css?.map(file => [file.file, file.bytes])).toEqual([["_nuxt/entry.css", 60], ["_nuxt/slug.css", 7]])
    expect(report.chunks.find(file => file.file === "_nuxt/slug.js")).toMatchObject({ imports: ["_nuxt/shared.js"], css: ["_nuxt/slug.css"] })
  })

  it("counts the startup files and the static closure of each component, but no lazy chunk", () => {
    const routes = createBundleReport([clientReport()])!.client!.routes!
    expect(routes.map(route => [route.path, route.bytes, route.pageBytes, route.cssBytes])).toEqual([
      ["/docs/:slug()", 2150, 650, 67],
      ["/docs", 1650, 150, 60],
      ["/", 1520, 20, 60],
    ])
    expect(routes[0]!.files.map(file => [file.file, file.startup])).toEqual([
      ["_nuxt/entry.js", true],
      ["_nuxt/vue.js", true],
      ["_nuxt/shared.js", false],
      ["_nuxt/slug.js", false],
      ["_nuxt/docs.js", false],
      ["_nuxt/entry.css", true],
      ["_nuxt/default.js", false],
      ["_nuxt/slug.css", false],
    ])
  })

  it("explains a concrete path through its dynamic route and lists the modules that the route adds", () => {
    const explanation = explainBundleRoute([clientReport()], "/docs/kv")!
    expect(explanation.route.path).toBe("/docs/:slug()")
    expect(explanation.modules.map(module => module.id)).toEqual([
      "app/pages/docs/[slug].vue",
      "app/components/Code.vue",
      "node_modules/shiki/index.js",
      "app/pages/docs.vue",
      "app/layouts/default.vue",
    ])
    expect(explainBundleRoute([clientReport()], "/nowhere/else")).toBeUndefined()
  })

  it("prints the largest routes and explains a route path in the CLI", async () => {
    const dir = tempDir()
    writeEnvironmentReport(dir, clientReport())
    const run = async (feature: "report" | "why", args: string[]) => {
      let stdout = ""
      const context = { cwd: dir, rootDir: dir, stdout: { write: (text: string) => { stdout += text } }, stderr: { write: () => {} } } as unknown as ViteHubCliContext
      const namespace = bundleCliContributor.namespaces![0]!
      const code = await namespace.features.find(candidate => candidate.name === feature)!.run(args, context)
      return { code, stdout }
    }
    const report = await run("report", [])
    expect(report.stdout).toContain("Largest routes (first visit, page files only):\n    2.1 kB   650 B  /docs/:slug()\n    1.6 kB   150 B  /docs\n    1.5 kB    20 B  /")
    const why = await run("why", ["/docs/kv"])
    expect(why.stdout).toContain("Route /docs/:slug(): 2.1 kB of JavaScript on a first visit")
    expect(why.stdout).toContain("Startup files: 1.5 kB in 2 files. Page files: 650 B in 4 files.")
    expect(why.stdout).toContain("_nuxt/entry.js  [startup]")
    const json = JSON.parse((await run("why", ["/docs/kv", "--json"])).stdout)
    expect(json.target).toBe("/docs/kv")
    expect(json.route.bytes).toBe(2150)
    const missing = await run("why", ["/nowhere/else"])
    expect(missing.stdout).toContain("No page route of the last build renders /nowhere/else.")
    writeEnvironmentReport(dir, { ...clientReport(), routeOptions: { unavailable: "Custom router options can replace routes." } })
    expect((await run("report", [])).stdout).toContain("Routes unavailable: Custom router options can replace routes.")
    const unavailable = await run("why", ["/runtime-only"])
    expect(unavailable.code).toBe(1)
    expect(unavailable.stdout).toContain("Routes unavailable:")
    expect(unavailable.stdout).not.toContain("No page route")
    expect(JSON.parse((await run("why", ["/runtime-only", "--json"])).stdout)).toEqual({ target: "/runtime-only", unavailable: "Custom router options can replace routes." })

    const layerFile = "/absolute/layer/file.vue"
    writeEnvironmentReport(dir, collectEnvironmentReport({
      "layer.js": chunk("layer.js", "x".repeat(100), [layerFile], { entry: true }),
    }, {
      build: "b", environment: "client", side: "client", root, outDir: `${root}/dist`, getModuleInfo: noGraph(layerFile),
      routeOptions: { unavailable: "Custom router options can replace routes." },
    }))
    for (const target of [layerFile, "/absolute/layer"]) {
      const explanation = await run("why", [target])
      expect(explanation.code).toBe(0)
      expect(explanation.stdout).toContain("Client: 100 B")
      expect(explanation.stdout).toContain(layerFile)
      const json = await run("why", [target, "--json"])
      expect(json.code).toBe(0)
      expect(JSON.parse(json.stdout)).toMatchObject({ target, explanations: [{ target: layerFile, bytes: 100 }] })
    }
  })
})

describe("real Vite build", () => {
  it("matches the JavaScript and CSS that Vite's manifest loads for each page", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "package.json"), '{"type":"module"}')
    mkdirSync(join(dir, "pages"))
    writeFileSync(join(dir, "shared.js"), `export const shared = ${JSON.stringify("shared".repeat(200))}`)
    writeFileSync(join(dir, "lazy.js"), `export const lazy = ${JSON.stringify("lazy".repeat(500))}`)
    writeFileSync(join(dir, "pages/a.css"), ".a { color: red }")
    writeFileSync(join(dir, "pages/a.js"), `import "./a.css"\nimport { shared } from "../shared.js"\nexport default () => [shared, import("../lazy.js")]`)
    writeFileSync(join(dir, "pages/b.js"), `import { shared } from "../shared.js"\nexport default () => shared + "b"`)
    writeFileSync(join(dir, "main.js"), `window.pages = { "/a": () => import("./pages/a.js"), "/b": () => import("./pages/b.js") }`)
    writeFileSync(join(dir, "index.html"), `<script type="module" src="/main.js"></script>`)
    const plugin = hubBundle()
    plugin.api.setRoutes([{ path: "/a", files: [join(dir, "pages/a.js")] }, { path: "/b", files: [join(dir, "pages/b.js")] }])
    await build({ configFile: false, root: dir, plugins: [plugin], logLevel: "silent", build: { manifest: true } })

    const out = join(dir, "dist")
    const manifest = JSON.parse(readFileSync(join(out, ".vite/manifest.json"), "utf8")) as Record<string, { file: string, imports?: string[], css?: string[] }>
    // What Vite's preload helper and an SSR renderer load: the entry and the page, each with its static imports.
    const loads = (keys: string[]) => {
      const files = new Set<string>()
      const pending = [...keys]
      while (pending.length) {
        const entry = manifest[pending.pop()!]!
        if (files.has(entry.file)) continue
        files.add(entry.file)
        for (const css of entry.css ?? []) files.add(css)
        pending.push(...entry.imports ?? [])
      }
      return files
    }
    const routes = createBundleReport(readEnvironmentReports(dir))!.client!.routes!
    for (const [path, page] of [["/a", "pages/a.js"], ["/b", "pages/b.js"]] as const) {
      const route = routes.find(candidate => candidate.path === path)!
      const expected = loads(["index.html", page])
      expect(new Set(route.files.map(file => file.file))).toEqual(expected)
      const size = [...expected].reduce((sum, file) => sum + statSync(join(out, file)).size, 0)
      expect(route.bytes + route.cssBytes).toBe(size)
    }
    expect(routes.find(route => route.path === "/a")!.files.some(file => file.file.includes("lazy"))).toBe(false)
  })
})
