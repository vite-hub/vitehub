import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"
import { createAuthNitroConfig, hubAuth } from "../src/vite.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createProject(routes: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-auth-cached-"))
  tempDirs.push(root)
  await mkdir(join(root, "server"), { recursive: true })
  await writeFile(join(root, "server/auth.ts"), [
    "import { defineAuth } from '@vite-hub/auth'",
    "export default defineAuth({",
    `  access: { routes: [${routes.join(", ")}] },`,
    "})",
    "",
  ].join("\n"))
  return root
}

type RouteRules = Record<string, Record<string, unknown>>
type NitroHook = (...args: unknown[]) => unknown

/** A Nitro instance with the hooks, options, and logger that the Auth Nitro module reads. */
function createNitro(routeRules: RouteRules, baseURL = "/", builder: string | false = "vite") {
  const hooks = new Map<string, NitroHook[]>()
  const warnings: unknown[] = []
  const nitro = {
    hooks: {
      hook: (name: string, callback: NitroHook) => { hooks.set(name, [...hooks.get(name) ?? [], callback]) },
      callHook: async (name: string, ...args: unknown[]) => { for (const callback of hooks.get(name) ?? []) await callback(...args) },
    },
    logger: { warn: (error: unknown) => { warnings.push(error) } },
    options: { baseURL, builder, routeRules },
  }
  return { nitro, warnings }
}

type TestNitro = ReturnType<typeof createNitro>["nitro"]

/** Installs the Nitro modules of the config as Nitro does. */
async function installNitroModules(config: Record<string, unknown>, nitro: TestNitro): Promise<void> {
  const modules = Array.isArray(config.modules) ? config.modules : []
  for (const module of modules) await (module as { setup: (nitro: TestNitro) => unknown }).setup(nitro)
}

/** Runs the hooks that Nitro calls before a bundler builds: `build:before`, then `build:config`. */
async function runBuildHooks(nitro: TestNitro): Promise<void> {
  await nitro.hooks.callHook("build:before", nitro)
  if (nitro.options.builder !== false) await nitro.hooks.callHook("build:config", nitro, {})
}

async function buildNitro(config: Record<string, unknown>, routeRules: RouteRules, baseURL = "/"): Promise<void> {
  const { nitro } = createNitro(routeRules, baseURL)
  await installNitroModules(config, nitro)
  await runBuildHooks(nitro)
}

async function buildViteApp(routes: string[], routeRules: RouteRules, baseURL?: string): Promise<void> {
  const root = await createProject(routes)
  await buildNitro(createAuthNitroConfig(hubAuth(), { nitro: {}, projectRoot: root }), routeRules, baseURL)
}

describe("Auth access routes with cache route rules", () => {
  it("fails the build when an swr rule caches a guarded route", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/dashboard/**": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("Route rule \"/dashboard/**\" sets `cache` on GET requests to paths that the `access.routes` entry \"/dashboard/**\" guards"),
      fix: expect.stringContaining("cache: false"),
    })
  })

  it("fails the build when a prerender rule covers a guarded route", async () => {
    await expect(buildViteApp(["'/account'"], { "/**": { prerender: true } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("Route rule \"/**\" sets `prerender` on GET requests to paths that the `access.routes` entry \"/account\" guards"),
    })
  })

  it("fails the build when a rule caches a path below a guarded route", async () => {
    await expect(buildViteApp(["'/admin/**'"], { "/admin/:id/report": { isr: 60 } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("Route rule \"/admin/:id/report\" sets `isr`"),
    })
  })

  it("reads access routes and route rules below the Nitro base URL", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/dashboard/**": { swr: 60 } }, "/portal/")).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/portal/admin/**'"], { "/admin/**": { swr: 60 } }, "/portal/")).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/portal/admin/**'"], { "/blog/**": { swr: 60 } }, "/portal/")).resolves.toBeUndefined()
    // Nitro mounts every rule key below the base URL, also a key that starts with it: this rule caches "/portal/portal/report".
    await expect(buildViteApp(["'/portal/**'"], { "/portal/report": { swr: 60 } }, "/portal/")).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/portal/report'"], { "/report": { swr: 60 } }, "/portal/")).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/portal/report'"], { "/portal/report": { swr: 60 } }, "/portal/")).resolves.toBeUndefined()
  })

  it("passes when the cached route is not guarded", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/blog/**": { swr: 60 }, "/": { prerender: true } })).resolves.toBeUndefined()
  })

  it("passes when the guarded route turns off an inherited cache", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/**": { swr: 60 }, "/dashboard/**": { cache: false } })).resolves.toBeUndefined()
  })

  it("passes when the guard covers only methods that are not cached", async () => {
    await expect(buildViteApp(["{ route: '/api/posts', method: 'POST' }"], { "/api/**": { swr: 60 } })).resolves.toBeUndefined()
  })

  it("fails the build when a narrower rule turns off the cache on only part of a guarded route", async () => {
    const cases: RouteRules[] = [
      { "/admin/**": { swr: 60 }, "/admin": { cache: false } },
      { "/admin/:id": { swr: 60 }, "/admin/_": { cache: false } },
      { "/admin/**/report": { swr: 60 } },
      { "/admin/:id(\\d+)": { swr: 60 } },
      { "/**": { swr: 60 }, "/admin/**": { cache: false }, "/admin/public/**": { swr: 60 } },
    ]
    for (const routeRules of cases) {
      await expect(buildViteApp(["'/admin/**'"], routeRules), JSON.stringify(routeRules)).rejects.toMatchObject({ code: "AUTH_B0002" })
    }
  })

  it("checks each cached method that the guard covers", async () => {
    await expect(buildViteApp(["'/admin/**'"], { "HEAD /admin/**": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("on HEAD requests"),
    })
    // GET rules apply to HEAD requests too.
    await expect(buildViteApp(["{ route: '/admin/**', method: 'HEAD' }"], { "GET /admin/**": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["{ route: '/admin/**', method: 'HEAD' }"], {
      "GET /admin/**": { swr: 60 },
      "HEAD /admin/**": { cache: false },
    })).resolves.toBeUndefined()
    await expect(buildViteApp(["{ route: '/admin/**', method: 'GET' }"], { "HEAD /admin/**": { swr: 60 } })).resolves.toBeUndefined()
  })

  it("reads the route rules that a later build hook adds", async () => {
    const root = await createProject(["'/dashboard/**'"])
    const { nitro } = createNitro({})
    await installNitroModules(createAuthNitroConfig(hubAuth(), { nitro: {}, projectRoot: root }), nitro)
    // Nuxt runs `nitro:build:before` in a `build:before` hook that it adds after the Nitro modules.
    nitro.hooks.hook("build:before", () => { nitro.options.routeRules["/dashboard"] = { swr: 60 } })
    await expect(runBuildHooks(nitro)).rejects.toMatchObject({ code: "AUTH_B0002" })
  })

  it("checks the route rules before Nitro starts without a builder", async () => {
    const root = await createProject(["'/dashboard/**'"])
    const { nitro } = createNitro({ "/dashboard/**": { swr: 60 } }, "/", false)
    await installNitroModules(createAuthNitroConfig(hubAuth(), { nitro: {}, projectRoot: root }), nitro)
    await expect(runBuildHooks(nitro)).rejects.toMatchObject({ code: "AUTH_B0002" })
  })

  it("stops the build for a guard path with route pattern syntax", async () => {
    for (const route of ["'/reports/(drafts)/**'", "'/files/:name'", "'/files/*'"]) {
      await expect(buildViteApp([route], { "/files/report": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_C0063" })
    }
  })

  it("reads guard paths as the access middleware matches them", async () => {
    await expect(buildViteApp(["'/reports/'"], { "/reports": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/files/a+b'"], { "/files/a+b": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/files/a+b'"], { "/files/ab": { swr: 60 } })).resolves.toBeUndefined()
  })

  it("logs a warning and keeps the route rules when a development update caches a guarded route", async () => {
    const root = await createProject(["'/dashboard/**'"])
    const { nitro, warnings } = createNitro({ "/blog/**": { swr: 60 } })
    await installNitroModules(createAuthNitroConfig(hubAuth(), { nitro: {}, projectRoot: root }), nitro)
    await runBuildHooks(nitro)
    const served: RouteRules[] = []
    nitro.hooks.hook("build:reload", () => { served.push(nitro.options.routeRules) })
    // `nitro.updateConfig({ routeRules })` replaces the route rules, then calls `build:reload` without waiting for it,
    // so two updates can overlap.
    const routeRuleUpdates: RouteRules[] = [{ "/news": { swr: 60 } }, { "/dashboard": { swr: 60 } }]
    const updates = routeRuleUpdates.map((routeRules) => {
      nitro.options.routeRules = routeRules
      return nitro.hooks.callHook("build:reload")
    })
    await Promise.all(updates)
    expect(warnings).toEqual([expect.objectContaining({ code: "AUTH_B0002" })])
    expect(served).toEqual([{ "/dashboard": { swr: 60 } }, { "/dashboard": { swr: 60 } }])
  })

  it("fails the Nuxt build when a route rule caches a guarded route", async () => {
    const root = await createProject(["'/dashboard/**'"])
    const hooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
    const nuxt = {
      hook: (name: string, handler: (config: Record<string, unknown>) => Promise<void>) => { if (name === "nitro:config") hooks.push(handler) },
      options: { rootDir: root },
    }
    hubAuthNuxt({ env: false }, nuxt)
    const nitro: Record<string, unknown> = {}
    for (const hook of hooks) await hook(nitro)
    await expect(buildNitro(nitro, { "/dashboard/**": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_B0002" })
  })
})
