import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { addRoute, createRouter, findAllRoutes } from "rou3"
import { compileRouter } from "rou3/compiler"
import { describe, expect, it, vi } from "vitest"

import { hubEnv } from "@vite-hub/env/vite"

import hubAuthNuxt from "../src/nuxt.ts"

function createNuxt() {
  const hooks: Array<((config: Record<string, unknown>) => Promise<void>) | (() => void)> = []
  const hookNames: string[] = []
  return {
    hook(name: "modules:done" | "nitro:config", handler: ((config: Record<string, unknown>) => Promise<void>) | (() => void)) {
      hooks.push(handler)
      hookNames.push(name)
    },
    hookNames,
    hooks,
    options: {
      alias: { "#existing": "/tmp/existing.mjs" },
      imports: {
        imports: [{ from: "app/composables", name: "useSession" }],
      },
      nitro: {
        alias: { "#nitro-existing": "/tmp/nitro-existing.mjs" },
        plugins: ["/tmp/existing-plugin.mjs"],
      },
      plugins: [] as Array<string | { src: string, order?: number }>,
      rootDir: "/tmp/vitehub-auth-nuxt",
    },
  }
}

/** Runs every handler registered for a hook, in registration order, as Nuxt does. */
async function runHook(nuxt: ReturnType<typeof createNuxt>, name: string, input: Record<string, unknown>) {
  for (const [index, hook] of nuxt.hooks.entries()) {
    if (nuxt.hookNames[index] === name) await (hook as (config: Record<string, unknown>) => Promise<void>)(input)
  }
}

describe("Auth Nuxt integration", () => {
  it("installs the Vue context bridge before existing Nuxt plugins", () => {
    const nuxt = createNuxt()
    nuxt.options.plugins = ["/tmp/user-plugin.mjs"]

    hubAuthNuxt({ env: false }, nuxt)

    expect(nuxt.options.plugins?.[0]).toMatchObject({ order: -1 })
    expect(nuxt.options.plugins?.[0]).toMatchObject({ src: expect.stringMatching(/\/runtime\/vue-nuxt\.js$/) })
    expect(nuxt.options.plugins?.[1]).toBe("/tmp/user-plugin.mjs")

    nuxt.options.plugins.unshift("/tmp/later-module-plugin.mjs")
    nuxt.hooks[1]({} as never)
    expect(nuxt.options.plugins?.[0]).toMatchObject({ order: -1 })
  })
  it("passes the page guard defaults to the app and types definePageMeta({ auth })", () => {
    const hooks = new Map<string, (input: { declarations: string[] }) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (input: { declarations: string[] }) => void) => hooks.set(name, handler) }
    hubAuthNuxt({ env: false }, nuxt as never)
    expect((nuxt.options as { runtimeConfig?: unknown }).runtimeConfig).toEqual({ public: { vitehubAuth: { basePath: "/api/auth", signInPage: "/login", afterSignIn: "/" } } })
    const declarations: string[] = []
    hooks.get("prepare:types")?.({ declarations })
    expect(declarations.join("\n")).toContain('auth?: import("@vite-hub/auth/nuxt").AuthPageMeta')
  })

  it("links the definePageMeta({ auth }) type to the docs page that explains the page guard", async () => {
    const hooks = new Map<string, (input: { declarations: string[] }) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (input: { declarations: string[] }) => void) => hooks.set(name, handler) }
    hubAuthNuxt({ env: false }, nuxt as never)
    const declarations: string[] = []
    hooks.get("prepare:types")?.({ declarations })

    const path = /https:\/\/vitehub\.dev(\/docs\/[\w/-]+)/.exec(declarations.join("\n"))?.[1]
    expect(path).toBe("/docs/auth/protect-pages")
    await expect(access(new URL(`../../../docs/content${path}.md`, import.meta.url))).resolves.toBeUndefined()
  })

  it("removes Better Auth's client and the lazy composables from the prefetch hints of every page", () => {
    type Manifest = Record<string, { isEntry?: boolean, dynamicImports?: string[] }>
    const hooks = new Map<string, (manifest: Manifest) => void>()
    const nuxt = { ...createNuxt(), hook: (name: string, handler: (manifest: Manifest) => void) => hooks.set(name, handler) }
    const root = "/tmp/vitehub-auth-nuxt/app"
    hubAuthNuxt({ env: false }, { ...nuxt, options: { ...nuxt.options, srcDir: "/tmp/vitehub-auth-nuxt/other", vite: { root } } } as never)
    // Vite writes manifest keys relative to its root, from the real path of each module.
    const client = relative(root, realpathSync(fileURLToPath(import.meta.resolve("better-auth/vue"))))
    // The built composables sit next to the built module. This test runs the source, so `src/vue.js` is a stand-in.
    const composables = relative(root, fileURLToPath(new URL("../src/vue.js", import.meta.url)))
    const manifest: Manifest = {
      "entry.js": { isEntry: true, dynamicImports: [client, composables, "pages/index.vue"] },
      [client]: {},
      [composables]: {},
      "pages/index.vue": { dynamicImports: [client] },
    }

    hooks.get("build:manifest")?.(manifest)

    expect(manifest).toMatchObject({
      "entry.js": { isEntry: true, dynamicImports: ["pages/index.vue"] },
      "pages/index.vue": { dynamicImports: [] },
    })
  })

  it("turns the page guard off with auth: false", () => {
    const nuxt = { options: { rootDir: "/tmp/vitehub-auth-nuxt", vite: { root: "/tmp/vitehub-auth-nuxt" }, runtimeConfig: {} } }

    hubAuthNuxt({ env: false, auth: false }, nuxt)

    expect(nuxt.options.runtimeConfig).toEqual({ public: { vitehubAuth: false } })
  })

  it("fails for the removed redirects option with its move fix", () => {
    const nuxt = { options: { rootDir: "/tmp/vitehub-auth-nuxt", vite: { root: "/tmp/vitehub-auth-nuxt" }, runtimeConfig: {} } }

    expect(() => hubAuthNuxt({ env: false, auth: { redirects: { login: "/sign-in" } } } as never, nuxt)).toThrow(expect.objectContaining({ code: "AUTH_REDIRECTS_MOVED" }))
  })

  /** Runs the module on an app whose `server/auth.ts` sets `access.pages`, and returns the Nuxt route rules. */
  function guardAccessPages(pages: Record<string, unknown>, routeRules: Record<string, Record<string, unknown>> = {}) {
    const rootDir = mkdtempSync(join(tmpdir(), "vitehub-auth-nuxt-pages-"))
    try {
      mkdirSync(join(rootDir, "server"))
      writeFileSync(join(rootDir, "server/auth.ts"), `import { defineAuth } from '@vite-hub/auth'\nexport default defineAuth({ access: { pages: ${JSON.stringify(pages)} } })\n`)
      const nuxt = { options: { rootDir, routeRules: structuredClone(routeRules) } }
      hubAuthNuxt({ env: false }, nuxt)
      return nuxt.options.routeRules
    }
    finally {
      rmSync(rootDir, { force: true, recursive: true })
    }
  }

  it("attaches the page guard to the pages of access.pages through appMiddleware route rules", () => {
    const routeRules = guardAccessPages({ "/dashboard/**": "user", "/dashboard/public": false, "/dashboard/welcome": "guest", "/login": "guest" }, { "/dashboard/**": { appMiddleware: "track" }, "/docs/**": { prerender: true } })

    expect(routeRules).toEqual({
      "/dashboard/**": { appMiddleware: { "track": true, "vitehub-auth-user": true, "vitehub-auth-guest": false } },
      "/dashboard/public": { appMiddleware: { "vitehub-auth-user": false, "vitehub-auth-guest": false } },
      "/dashboard/welcome": { appMiddleware: { "vitehub-auth-user": false, "vitehub-auth-guest": true } },
      "/docs/**": { prerender: true },
      "/login": { appMiddleware: { "vitehub-auth-user": false, "vitehub-auth-guest": true } },
    })
  })

  /** Runs the module twice, as Nuxt does with layers, on an app with this `server/auth.ts`, and returns its Nuxt options. */
  function runModule(source: string) {
    const rootDir = mkdtempSync(join(tmpdir(), "vitehub-auth-nuxt-pages-"))
    try {
      mkdirSync(join(rootDir, "server"))
      writeFileSync(join(rootDir, "server/auth.ts"), `import { defineAuth } from '@vite-hub/auth'\n${source}\n`)
      const nuxt: NonNullable<Parameters<typeof hubAuthNuxt>[1]> = { options: { rootDir, runtimeConfig: {} } }
      hubAuthNuxt({ env: false, nitro: false }, nuxt)
      hubAuthNuxt({ env: false, nitro: false }, nuxt)
      return nuxt.options
    }
    finally {
      rmSync(rootDir, { force: true, recursive: true })
    }
  }

  it("adds no server middleware to an app without access.pages, so a public page needs no Env", () => {
    // Without deploy credentials, a middleware that resolves the Env of this callback fails each prerendered page.
    expect(runModule("export default defineAuth(({ env }) => ({ secret: env.AUTH_SECRET }))").nitro ?? {}).not.toHaveProperty("handlers")
  })

  it("stops the build when access is a variable that can hold access.pages", () => {
    expect(() => runModule("const access = { pages: { '/admin/**': 'user' } }\nexport default defineAuth(() => ({ access }))")).toThrow(expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID" }))
  })

  it("stops the build on an invalid access.pages entry", () => {
    expect(() => guardAccessPages({ "/account": "user", "/account/:id?": false })).toThrow(expect.objectContaining({ code: "AUTH_PAGE_ROUTES_INVALID", message: expect.stringContaining('"/account/:id?": false') }))
  })

  /** Resolves the Auth mode of a page like Nuxt 5: all matching route rules, less specific first, with later rules winning. */
  function resolveAuthMode(pages: Record<`/${string}`, "user" | "guest" | false>, existing: Record<string, Record<string, unknown>> = {}) {
    return authModeOf(guardAccessPages(pages, existing))
  }

  /** The `appMiddleware` flags that the Nuxt 5 matcher merges on a path, least specific pattern first. */
  function middlewareOf(routeRules: Record<string, Record<string, unknown>>) {
    const router = createRouter<Record<string, unknown>>()
    for (const [pattern, rule] of Object.entries(routeRules)) addRoute(router, "", pattern, rule)
    const compiled = compileRouter(router, { matchAll: true })
    const flags = (matches: Array<{ data: Record<string, unknown> }>): Record<string, boolean> => Object.assign({}, ...matches.map(match => match.data.appMiddleware))
    return (path: string) => {
      const interpreted = flags(findAllRoutes(router, "", path))
      expect(flags(compiled("", path))).toEqual(interpreted)
      return interpreted
    }
  }

  function authModeOf(routeRules: Record<string, Record<string, unknown>>) {
    const middleware = middlewareOf(routeRules)
    return (path: string) => {
      const flags = middleware(path)
      return flags["vitehub-auth-user"] ? "user" : flags["vitehub-auth-guest"] ? "guest" : "public"
    }
  }

  type Rule = Record<string, unknown>
  type InlinePage = { path: string, rules?: Rule, children?: InlinePage[] }

  /**
   * What Nuxt does with the `defineRouteRules()` of the pages after `pages:resolved`: it keys each page by its rou3
   * pattern, merges it over the route rule of that pattern with `defu`, then expands a middleware name or list.
   */
  async function mergeInlineRouteRules(pages: InlinePage[], routeRules: Record<string, Rule>) {
    const { vueRouterToRou3 } = await import("unrouting")
    const isRule = (value: unknown): value is Rule => typeof value === "object" && value !== null && !Array.isArray(value)
    // `defu` concatenates two lists, merges two objects, and otherwise keeps the value of the page.
    const defu = (inline: Rule, base: Rule = {}): Rule => Object.fromEntries([...new Set([...Object.keys(inline), ...Object.keys(base)])].map((key) => {
      const value = inline[key]
      const fallback = base[key]
      if (value === undefined) return [key, fallback]
      if (Array.isArray(value) && Array.isArray(fallback)) return [key, [...value, ...fallback]]
      return [key, isRule(value) && isRule(fallback) ? defu(value, fallback) : value]
    }))
    const collect = (list: InlinePage[], prefix: string) => {
      for (const page of list) {
        if (page.rules) for (const pattern of vueRouterToRou3(prefix + page.path, { collapse: true }).patterns) routeRules[pattern] = defu(page.rules, routeRules[pattern])
        if (page.children) collect(page.children, `${prefix}${page.path}/`)
      }
    }
    collect(pages, "")
    for (const rule of Object.values(routeRules)) {
      const middleware = rule.appMiddleware
      if (typeof middleware === "string" || Array.isArray(middleware)) rule.appMiddleware = Object.fromEntries([middleware].flat().map(name => [name, true]))
    }
  }

  /** Runs the Auth Nuxt module with `server/auth.ts`, then Nuxt's `pages:resolved` hooks and inline rule merge. */
  async function resolveInlineRouteRules(auth: string, routeRules: Record<string, Rule>, pages: InlinePage[]) {
    const rootDir = mkdtempSync(join(tmpdir(), "vitehub-auth-nuxt-inline-"))
    try {
      mkdirSync(join(rootDir, "server"))
      writeFileSync(join(rootDir, "server/auth.ts"), `import { defineAuth } from '@vite-hub/auth'\nexport default defineAuth(${auth})\n`)
      const resolved: Array<(pages: unknown[]) => unknown> = []
      const nuxt = { options: { rootDir, routeRules }, hook: (name: string, handler: (pages: unknown[]) => unknown) => { if (name === "pages:resolved") resolved.push(handler) } }
      hubAuthNuxt({ env: false }, nuxt as never)
      for (const handler of resolved) await handler(pages)
      await mergeInlineRouteRules(pages, routeRules)
      return middlewareOf(routeRules)
    }
    finally {
      rmSync(rootDir, { force: true, recursive: true })
    }
  }

  it.each([
    [{ "/dashboard/**": "user", "/dashboard/pricing": false, "/login": "guest" }, { "/dashboard": "user", "/dashboard/x/y": "user", "/dashboard/pricing": "public", "/login": "guest", "/": "public" }],
    [{ "/**": "user", "/docs/**": false, "/login": "guest" }, { "/docs": "public", "/docs/a/b": "public", "/login": "guest", "/x": "user" }],
    [{ "/account": "user", "/account/:id": false }, { "/account": "user", "/account/1": "public" }],
    [{ "/account/:id": "user", "/account/:id/:tab": false }, { "/account/1": "user", "/account/1/x": "public" }],
    [{ "/:org/settings": "user", "/acme/:page": false }, { "/acme/settings": "public", "/other/settings": "user" }],
    [{ "/a/**": false, "/a/:b/**": "user", "/a/:b/c": "guest" }, { "/a": "public", "/a/b": "user", "/a/b/c": "guest", "/a/b/c/d": "user" }],
    [{ "/team/**": false, "/team/:id": "user" }, { "/team": "public", "/team/a": "user", "/team/a/b": "public" }],
    [{ "/**": "guest", "/:id": "user", "/x": false }, { "/x": "public", "/y": "user", "/y/z": "guest" }],
  ] as const)("keeps the most specific pattern of %j in any key order through the Nuxt 5 matcher", (pages, expected) => {
    const entries = Object.entries(pages)
    for (const order of [entries, [...entries].reverse()]) {
      const resolve = resolveAuthMode(Object.fromEntries(order))
      expect(Object.fromEntries(Object.keys(expected).map(path => [path, resolve(path)]))).toEqual(expected)
    }
  })

  it("keeps the most specific pattern when the app has route rules on the same patterns", () => {
    const existing = { "/account/public": { appMiddleware: "track" }, "/account/**": { appMiddleware: ["audit"] } }
    const resolve = resolveAuthMode({ "/account/public": false, "/account/**": "user" }, existing)

    expect([resolve("/account/public"), resolve("/account/x")]).toEqual(["public", "user"])
  })

  it("keeps the page guard when a page sets appMiddleware with defineRouteRules", async () => {
    const middleware = await resolveInlineRouteRules("{ access: { pages: { '/dashboard': 'user', '/team/:id': 'user' } } }", {}, [
      { path: "/dashboard", rules: { appMiddleware: "audit" } },
      { path: "/team", children: [{ path: ":id()", rules: { appMiddleware: ["audit"] } }] },
    ])

    expect([middleware("/dashboard"), middleware("/team/1")]).toEqual([
      { "audit": true, "vitehub-auth-user": true, "vitehub-auth-guest": false },
      { "audit": true, "vitehub-auth-user": true, "vitehub-auth-guest": false },
    ])
  })

  it("keeps the app middleware of a page that access.pages does not guard", async () => {
    const middleware = await resolveInlineRouteRules("{ access: { pages: { '/dashboard': 'user' } } }", { "/members": { appMiddleware: ["require-member"] } }, [
      { path: "/members", rules: { appMiddleware: ["audit"] } },
    ])

    expect(middleware("/members")).toEqual({ "audit": true, "require-member": true })
  })

  it("keeps the app middleware on the unguarded pattern of a page with an optional parameter", async () => {
    // `/team/:id?` has the rou3 patterns `/team` and `/team/:_0`, and access.pages guards only `/team/:_0`. Nuxt merges
    // the inline rules of the page over the rule of each pattern, so the record that keeps the guard on `/team/:_0` must
    // not replace the list of the app on `/team`.
    const middleware = await resolveInlineRouteRules("{ access: { pages: { '/team/:_0': 'user' } } }", { "/team": { appMiddleware: ["require-member"] } }, [
      { path: "/team/:id?", rules: { appMiddleware: ["audit"] } },
    ])

    expect([middleware("/team"), middleware("/team/1")]).toEqual([
      { "audit": true, "require-member": true },
      { "audit": true, "vitehub-auth-user": true, "vitehub-auth-guest": false },
    ])
  })

  it("disables the session bridge and guard through module Auth options", () => {
    const nuxt = { options: { rootDir: "/tmp/vitehub-auth-nuxt", runtimeConfig: {} } }

    hubAuthNuxt({ env: false, auth: false }, nuxt)

    expect(nuxt.options.runtimeConfig).toEqual({ public: { vitehubAuth: false } })
  })

  it("registers the Env resolver for the generated Auth Definition", async () => {
    const runtime = await readFile(new URL("../src/runtime/nuxt.ts", import.meta.url), "utf8")

    expect(runtime).toContain('import definition from "#vitehub/auth/definition"')
    expect(runtime).toContain("setAuthRuntimeEnvResolver(useServerEnv, definition)")
  })

  it("skips a useUserSession that another source already auto-imports and warns once", () => {
    const nuxt = createNuxt()
    nuxt.options.imports.imports.push({ from: "nuxt-auth-utils", name: "useUserSession" })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)
      hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)

      expect(nuxt.options.imports.imports.filter(entry => entry.name === "useUserSession")).toEqual([{ from: "nuxt-auth-utils", name: "useUserSession" }])
      expect(nuxt.options.imports.imports).toContainEqual({ from: "vite-hub/auth/vue", name: "useAbility", priority: -1 })
      expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("useUserSession"))).toEqual([
        "[vitehub] nuxt-auth-utils already auto-imports `useUserSession`, so ViteHub does not auto-import it from vite-hub/auth/vue. Import ViteHub's composable from \"vite-hub/auth/vue\" where you need it.",
      ])
    }
    finally {
      warn.mockRestore()
    }
  })

  it("installs Vue composables and the server Env runtime once", () => {
    const nuxt = createNuxt()

    hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)
    hubAuthNuxt({ importsFrom: "vite-hub/auth/vue" }, nuxt)
    const vite = (nuxt.options as typeof nuxt.options & {
      vite: { plugins: Array<{ name?: string }> }
    }).vite

    expect(nuxt.options.imports.imports).toEqual([
      { from: "app/composables", name: "useSession" },
      { from: "vite-hub/auth/vue", name: "useAbility", priority: -1 },
      { from: "vite-hub/auth/vue", name: "useAuthClient", priority: -1 },
      { from: "vite-hub/auth/vue", name: "useUserSession", priority: -1 },
    ])
    expect(nuxt.options.alias).toEqual({
      "#existing": "/tmp/existing.mjs",
      "#vitehub/env/description": "/tmp/vitehub-auth-nuxt/.vitehub/env/description.mjs",
      "#vitehub/env/public": "/tmp/vitehub-auth-nuxt/.vitehub/env/public.mjs",
      "#vitehub/env/server": "/tmp/vitehub-auth-nuxt/.vitehub/env/server.mjs",
    })
    expect(nuxt.options.nitro.alias).toEqual({
      "#nitro-existing": "/tmp/nitro-existing.mjs",
      "#vitehub/env/description": "/tmp/vitehub-auth-nuxt/.vitehub/env/description.mjs",
      "#vitehub/env/public": "/tmp/vitehub-auth-nuxt/.vitehub/env/public.mjs",
      "#vitehub/env/server": "/tmp/vitehub-auth-nuxt/.vitehub/env/server.mjs",
    })
    expect(nuxt.options.nitro.plugins).toHaveLength(2)
    expect(nuxt.options.nitro.plugins[1]).toMatch(/\/runtime\/nuxt\.js$/)
    expect(vite.plugins).toHaveLength(2)
    expect(vite.plugins).toEqual([
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
      expect.objectContaining({ name: "@vite-hub/auth/vite" }),
    ])
    // nitro:config, modules:done, prepare:types for the definePageMeta({ auth }) type, build:manifest, and pages:resolved
    // and nitro:init for the check of cached guarded pages. The app has no abilities, so no components:extend for <AuthPermission>.
    expect(nuxt.hookNames.toSorted()).toEqual(["build:manifest", "modules:done", "nitro:config", "nitro:init", "pages:resolved", "prepare:types"])
  })

  /** Runs the module on a temporary app with an Auth Definition, and returns the components that it registers. */
  async function registeredComponents(files: Record<string, string>, options: Parameters<typeof hubAuthNuxt>[0] = {}, existing: Array<Record<string, unknown>> = []) {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-components-"))
    try {
      for (const [path, contents] of Object.entries({ "server/auth.ts": "export default defineAuth({})\n", ...files })) {
        await mkdir(join(root, path, ".."), { recursive: true })
        await writeFile(join(root, path), contents)
      }
      const hooks = new Map<string, (components: Array<Record<string, unknown>>) => void>()
      const nuxt = { hook: (name: string, handler: (components: Array<Record<string, unknown>>) => void) => hooks.set(name, handler), options: { rootDir: root } }
      hubAuthNuxt({ env: false, importsFrom: "vite-hub/auth/vue", ...options }, nuxt as never)
      const components = [...existing]
      hooks.get("components:extend")?.(components)
      return { components, hooks: [...hooks.keys()] }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  it("registers no <AuthPermission> when the app has no abilities", async () => {
    const { components, hooks } = await registeredComponents({})
    expect(hooks).not.toContain("components:extend")
    expect(components).toEqual([])
  })

  it("registers no <AuthPermission> when Auth is off, even with abilities", async () => {
    const { components } = await registeredComponents({ "shared/abilities.ts": "export default {}\n" }, { auth: false })
    expect(components).toEqual([])
  })

  it("registers <AuthPermission> from the Vue entry when the app has abilities, unless the app has its own component", async () => {
    const component = (name: string) => ({
      chunkName: "components/auth-permission",
      export: name,
      filePath: "vite-hub/auth/vue",
      global: false,
      kebabName: "auth-permission",
      meta: {},
      mode: "all",
      pascalName: name,
      prefetch: false,
      preload: false,
      priority: 0,
      shortPath: "vite-hub/auth/vue",
    })
    const { components } = await registeredComponents({ "shared/abilities.ts": "export default {}\n" })
    expect(components).toEqual([component("AuthPermission")])

    const own = { pascalName: "AuthPermission", filePath: "/app/components/AuthPermission.vue" }
    expect((await registeredComponents({ "shared/abilities.ts": "export default {}\n" }, {}, [own])).components).toEqual([own])
  })

  // Each pair of names is what Nuxt gives `AuthPermission.vue` in a components directory with the same prefix,
  // `components: [{ path, prefix }]`.
  it.each([
    // Nuxt drops the prefix words that the component name starts with.
    ["Auth", "AuthPermission", "auth-permission"],
    ["auth", "AuthPermission", "auth-permission"],
    ["my-auth", "MyAuthPermission", "my-auth-permission"],
    ["my-auth-", "MyAuthPermission", "my-auth-permission"],
    ["MyAuth", "MyAuthPermission", "my-auth-permission"],
    ["AuthPermission", "AuthPermission", "auth-permission"],
    ["Custom", "CustomAuthPermission", "custom-auth-permission"],
    ["UI", "UIAuthPermission", "ui-auth-permission"],
    ["MonÉquipe", "MonÉquipeAuthPermission", "mon-équipe-auth-permission"],
    // Letters without case.
    ["日本", "日本AuthPermission", "日本-auth-permission"],
    // A combining mark: `e` followed by U+0301.
    ["équipe", "ÉquipeAuthPermission", "équipe-auth-permission"],
  ])("registers <AuthPermission> under the prefix %j as %s", async (prefix, pascalName, kebabName) => {
    const { components } = await registeredComponents({
      "server/auth.ts": `export default defineAuth({ components: { prefix: ${JSON.stringify(prefix)} } })\n`,
      "shared/abilities.ts": "export default {}\n",
    })
    // The export stays `AuthPermission`, so the generated component types read `typeof import("vite-hub/auth/vue")["AuthPermission"]`.
    expect(components).toEqual([
      expect.objectContaining({ chunkName: `components/${kebabName}`, export: "AuthPermission", filePath: "vite-hub/auth/vue", kebabName, pascalName }),
    ])
  })

  it("restarts Nuxt when app or layer abilities are added or removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-watch-"))
    try {
      const hooks = new Map<string, (event: string, path: string) => Promise<void>>()
      const nuxt = {
        callHook: vi.fn(async (_name: "restart") => {}),
        hook: (name: string, handler: (event: string, path: string) => Promise<void>) => hooks.set(name, handler),
        options: {
          dev: true,
          rootDir: root,
          _layers: [{ cwd: join(root, "layers/base"), config: { rootDir: join(root, "layers/base") } }],
        },
      }
      hubAuthNuxt({ env: false }, nuxt as never)
      expect(Reflect.get(nuxt.options, "watch")).toEqual([join(root, "shared"), join(root, "layers/base/shared")])
      const watch = hooks.get("builder:watch")!
      await watch("change", "shared/abilities.ts")
      await watch("add", "shared/other.ts")
      expect(nuxt.callHook).not.toHaveBeenCalled()

      await watch("add", "shared/abilities.ts")
      await watch("unlink", join(root, "layers/base/shared/abilities.mjs"))
      expect(nuxt.callHook.mock.calls).toEqual([["restart"], ["restart"]])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps Auth enabled when Env is disabled", () => {
    const nuxt = {
      options: {
        rootDir: "/tmp/vitehub-auth-nuxt",
      },
    }

    hubAuthNuxt({ env: false }, nuxt)
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string, name: string }> }
      vite: { plugins: Array<{ name?: string }> }
    }

    expect(options.vite.plugins).toContainEqual(
      expect.objectContaining({ name: "@vite-hub/auth/vite" }),
    )
    expect(options.imports.imports).toHaveLength(3)
    expect(options).not.toHaveProperty("alias")
    expect(options).not.toHaveProperty("nitro")
  })

  it("uses the configured roots for Auth discovery and Env imports", async () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: "/tmp/vite-root" }

    hubAuthNuxt({ env: { projectRoot: "/tmp/env-root" } }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/env-root/.vitehub/env/server.mjs")
    const plugins = (nuxt.options as typeof nuxt.options & { vite: { plugins: Array<{ config?: (config: { root?: string }) => unknown, name?: string }> } }).vite.plugins
    expect(plugins).toHaveLength(2)
    const authPlugin = plugins.find(plugin => plugin.name === "@vite-hub/auth/vite")!
    const authConfig = vi.fn(() => ({ nitro: {} }))
    authPlugin.config = authConfig
    await runHook(nuxt, "nitro:config", {})
    expect(authConfig).toHaveBeenCalledWith(expect.objectContaining({ root: "/tmp/vite-root" }), expect.anything())
  })

  it("resolves relative Env roots from the Vite root", () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: "/tmp/workspace/apps/site" }

    hubAuthNuxt({ env: { projectRoot: "../shared" } }, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/workspace/apps/shared/.vitehub/env/server.mjs")
  })

  it("preserves automatic Env project-root detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-auth-nuxt-root-"))
    const appRoot = join(root, "app")
    await mkdir(appRoot)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "auth-nuxt-root" }))
    try {
      const nuxt = createNuxt()
      ;(nuxt.options as typeof nuxt.options & { vite: { root: string } }).vite = { root: appRoot }

      hubAuthNuxt({}, nuxt)

      expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe(join(root, ".vitehub/env/server.mjs"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("reuses the installed Env plugin project root", () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { plugins: unknown[], root: string } }).vite = {
      plugins: [hubEnv({ projectRoot: "../shared" })],
      root: "/tmp/workspace/apps/site",
    }

    hubAuthNuxt({}, nuxt)

    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe("/tmp/workspace/apps/shared/.vitehub/env/server.mjs")
  })

  it("validates an explicit Env root against the installed plugin", () => {
    function createNuxtWithEnv() {
      const nuxt = createNuxt()
      ;(nuxt.options as typeof nuxt.options & { vite: { plugins: unknown[], root: string } }).vite = {
        plugins: [hubEnv({ projectRoot: "../shared" })],
        root: "/tmp/workspace/apps/site",
      }
      return nuxt
    }

    expect(() => hubAuthNuxt({ env: { projectRoot: "../shared" } }, createNuxtWithEnv())).not.toThrow()
    expect(() => hubAuthNuxt({ env: { projectRoot: "../other" } }, createNuxtWithEnv())).toThrow(
      "env.projectRoot must match the installed `@vite-hub/env/vite` plugin",
    )
  })

  it("ignores the top-level Vite Auth switch during Nitro replay", async () => {
    const nuxt = createNuxt()
    ;(nuxt.options as typeof nuxt.options & { vite: { auth: false } }).vite = { auth: false }

    hubAuthNuxt({}, nuxt)

    const plugins = (nuxt.options as typeof nuxt.options & { vite: { plugins: Array<{ config?: (config: { auth?: false }) => unknown, name?: string }> } }).vite.plugins
    const authPlugin = plugins.find(plugin => plugin.name === "@vite-hub/auth/vite")!
    const authConfig = vi.fn(() => ({ nitro: {} }))
    authPlugin.config = authConfig
    await runHook(nuxt, "nitro:config", {})
    expect(authConfig).toHaveBeenCalledWith(expect.not.objectContaining({ auth: false }), expect.anything())
  })

  it("does nothing before Nuxt initializes", () => {
    expect(hubAuthNuxt()).toBeUndefined()
  })
})
