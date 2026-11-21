import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"
import { assertNoCachedPageGuards } from "../src/page-guard-cache.ts"

import type { AuthNuxtModuleOptions } from "../src/nuxt.ts"

type RouteRules = Record<string, Record<string, unknown>>
type Page = { path: string, alias?: string[], meta?: Record<string, unknown>, children?: Page[] }
type Hook = (...args: never[]) => unknown
type NuxtOptions = { rootDir: string, ssr?: boolean, router?: { options?: { sensitive?: boolean } }, experimental?: { extraPageMetaExtractionKeys?: string[] } }

/** Installs the Auth Nuxt module, then runs the Nuxt and Nitro hooks of a build with these pages and route rules. */
async function buildNuxt(pages: Page[], routeRules: RouteRules, auth?: AuthNuxtModuleOptions["auth"], options: NuxtOptions = { rootDir: "/tmp/vitehub-auth-nuxt" }): Promise<NuxtOptions> {
  const nuxtHooks = new Map<string, Hook[]>()
  const nuxt = {
    hook: (name: string, handler: Hook) => { nuxtHooks.set(name, [...nuxtHooks.get(name) ?? [], handler]) },
    options,
  }
  hubAuthNuxt({ env: false, nitro: false, auth }, nuxt as never)
  const nitroHooks = new Map<string, Hook[]>()
  const nitro = {
    hooks: { hook: (name: string, handler: Hook) => { nitroHooks.set(name, [...nitroHooks.get(name) ?? [], handler]) } },
    options: { routeRules },
  }
  for (const handler of nuxtHooks.get("pages:resolved") ?? []) await (handler as (pages: Page[]) => unknown)(pages)
  for (const handler of nuxtHooks.get("nitro:init") ?? []) await (handler as (nitro: unknown) => unknown)(nitro)
  for (const handler of nitroHooks.get("build:config") ?? []) await (handler as () => unknown)()
  return options
}

const pages: Page[] = [
  { path: "/dashboard", meta: { auth: "user" }, children: [{ path: "settings" }, { path: "public", meta: { auth: false } }] },
  { path: "/users/:id()", alias: ["/members/:id()"], meta: { auth: { only: "user", redirectTo: "/sign-in" } } },
  { path: "/login", meta: { auth: "guest" } },
  { path: "/blog/:slug()", meta: {} },
]

describe("Nuxt page guard with cache route rules", () => {
  it("asks Nuxt to read `auth` of definePageMeta() at build time", async () => {
    const options = await buildNuxt([], {})
    expect(options.experimental?.extraPageMetaExtractionKeys).toEqual(["auth"])
    const existing = await buildNuxt([], {}, undefined, { rootDir: "/tmp/vitehub-auth-nuxt", experimental: { extraPageMetaExtractionKeys: ["layoutTitle", "auth"] } })
    expect(existing.experimental?.extraPageMetaExtractionKeys).toEqual(["layoutTitle", "auth"])
  })

  it("fails the build when a route rule caches a page that definePageMeta({ auth }) guards", async () => {
    await expect(buildNuxt(pages, { "/dashboard/settings": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_GUARDED_PAGE_CACHED",
      message: expect.stringContaining("Route rule \"/dashboard/settings\" sets `cache` on GET requests to the page \"/dashboard/settings\", which `definePageMeta({ auth })` guards"),
      fix: expect.stringContaining("cache: false"),
    })
    await expect(buildNuxt(pages, { "/users/**": { isr: true } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("the page \"/users/:id()\"") })
    await expect(buildNuxt(pages, { "/members/:id": { static: true } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("the page \"/members/:id()\"") })
    await expect(buildNuxt(pages, { "/**": { prerender: true } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("sets `prerender`") })
    await expect(buildNuxt(pages, { "/login": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("the page \"/login\"") })
    await expect(buildNuxt(pages, { "HEAD /dashboard": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("on HEAD requests") })
  })

  it("fails the build when a route rule caches the payload of a guarded page", async () => {
    await expect(buildNuxt(pages, { "/dashboard/_payload.json": { isr: 60 } })).rejects.toMatchObject({
      code: "AUTH_GUARDED_PAGE_CACHED",
      message: expect.stringContaining("Route rule \"/dashboard/_payload.json\" sets `isr` on GET requests to the payload of the page \"/dashboard\""),
    })
    await expect(buildNuxt(pages, { "/dashboard/public": { swr: 60 }, "/dashboard/public/_payload.json": { cache: { swr: true, maxAge: 60 } } })).resolves.toBeDefined()
  })

  it("passes when no route rule caches a guarded page", async () => {
    await expect(buildNuxt(pages, { "/dashboard/public": { swr: 60 }, "/blog/**": { swr: 60 }, "/": { prerender: true } })).resolves.toBeDefined()
    await expect(buildNuxt(pages, { "POST /dashboard": { cache: { maxAge: 60 } } })).resolves.toBeDefined()
    await expect(buildNuxt([], { "/**": { swr: 60 } })).resolves.toBeDefined()
  })

  it("prerenders a guest page, because Nuxt renders it without a cookie and the guard runs again in the browser", async () => {
    await expect(buildNuxt(pages, { "/login": { prerender: true } })).resolves.toBeDefined()
    await expect(buildNuxt([{ path: "/sign-in", meta: { auth: { only: "guest", redirectTo: "/home" } } }], { "/**": { prerender: true } })).resolves.toBeDefined()
    await expect(buildNuxt(pages, { "/login": { isr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED", message: expect.stringContaining("sets `isr`") })
  })

  it("does not check a page that Nuxt renders only in the browser", async () => {
    await expect(buildNuxt(pages, { "/**": { swr: 60, prerender: true } }, undefined, { rootDir: "/tmp/vitehub-auth-nuxt", ssr: false })).resolves.toBeDefined()
    // Nuxt adds `'/**': { ssr: true }` to the route rules.
    await expect(buildNuxt([{ path: "/dashboard", meta: { auth: "user" }, children: [{ path: "settings" }] }], { "/**": { ssr: true }, "/dashboard/**": { ssr: false, swr: 60 } })).resolves.toBeDefined()
    // `ssr: false` on `/dashboard` does not cover its payload or `/dashboard/settings`, and `ssr: true` turns server
    // rendering on again.
    await expect(buildNuxt(pages, { "/dashboard/**": { swr: 60 }, "/dashboard": { ssr: false } })).rejects.toMatchObject({ message: expect.stringContaining("the payload of the page \"/dashboard\"") })
    await expect(buildNuxt(pages, { "/dashboard/**": { swr: 60 }, "/dashboard": { ssr: false }, "/dashboard/_payload.json": { ssr: false } })).rejects.toMatchObject({ message: expect.stringContaining("the page \"/dashboard/settings\"") })
    await expect(buildNuxt(pages, { "/**": { ssr: false, swr: 60 }, "/dashboard/settings": { ssr: true } })).rejects.toMatchObject({ message: expect.stringContaining("the page \"/dashboard/settings\"") })
  })

  it("passes when a route rule turns the cache off on every guarded page", async () => {
    await expect(buildNuxt(pages, {
      "/**": { swr: 60, prerender: true },
      "/dashboard/**": { cache: false, prerender: false },
      "/users/**": { cache: false, prerender: false },
      "/members/**": { cache: false, prerender: false },
      "/login/**": { cache: false, prerender: false },
    })).resolves.toBeDefined()
  })

  it("fails the build when a route rule turns the cache off on only part of the guarded pages", async () => {
    // `/dashboard` does not match the guarded `/dashboard/settings`.
    await expect(buildNuxt(pages, { "/dashboard/**": { swr: 60 }, "/dashboard": { cache: false }, "/dashboard/_payload.json": { cache: false } })).rejects.toMatchObject({
      code: "AUTH_GUARDED_PAGE_CACHED",
      message: expect.stringContaining("the page \"/dashboard/settings\""),
    })
  })

  it("does not check the page guard when Auth is off", async () => {
    const options = await buildNuxt([{ path: "/dashboard", meta: { auth: "user" } }], { "/dashboard": { swr: 60 } }, false)
    expect(options.experimental).toBeUndefined()
  })

  it("keeps the payload and the HTML of a page apart", async () => {
    const dashboard: Page[] = [{ path: "/dashboard", meta: { auth: "user" } }]
    // A rule on the payload does not turn off the cache of the page.
    await expect(buildNuxt(dashboard, { "/**": { ssr: true, swr: 60 }, "/dashboard/_payload.json": { cache: false } })).rejects.toMatchObject({ message: expect.stringContaining("Route rule \"/**\" sets `cache` on GET requests to the page \"/dashboard\"") })
    await expect(buildNuxt(dashboard, { "/dashboard": { swr: 60 }, "GET /dashboard/_payload.json": { cache: false } })).rejects.toMatchObject({ message: expect.stringContaining("Route rule \"/dashboard\" sets `cache`") })
    // A rule on the page does not turn off the cache of the payload.
    await expect(buildNuxt(dashboard, { "/dashboard/**": { swr: 60 }, "/dashboard": { cache: false } })).rejects.toMatchObject({ message: expect.stringContaining("Route rule \"/dashboard/**\"") })
    await expect(buildNuxt(dashboard, { "/dashboard/**": { swr: 60 }, "/dashboard": { cache: false }, "/dashboard/_payload.json": { cache: false } })).resolves.toBeDefined()
  })

  it("compares paths without case unless the Nuxt router is case sensitive", async () => {
    await expect(buildNuxt(pages, { "/DASHBOARD": { swr: 60 } })).rejects.toMatchObject({ message: expect.stringContaining("Route rule \"/DASHBOARD\"") })
    await expect(buildNuxt([{ path: "/Dashboard", meta: { auth: "user" } }], { "/dashboard": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    await expect(buildNuxt(pages, { "/**": { swr: 60 }, "/DASHBOARD/**": { cache: false }, "/Users/**": { cache: false }, "/members/**": { cache: false }, "/LOGIN/**": { cache: false } })).resolves.toBeDefined()
    await expect(buildNuxt(pages, { "/DASHBOARD": { swr: 60 } }, undefined, { rootDir: "/tmp/vitehub-auth-nuxt", router: { options: { sensitive: true } } })).resolves.toBeDefined()
  })

  it("reads the guard of the page that Vue Router selects for a path", async () => {
    // The empty child page renders `/dashboard`, and its `auth: false` replaces the guard of the parent.
    const indexChild: Page[] = [{ path: "/dashboard", meta: { auth: "user" }, children: [{ path: "", meta: { auth: false } }, { path: "settings" }] }]
    await expect(buildNuxt(indexChild, { "/dashboard": { swr: 60 } })).resolves.toBeDefined()
    await expect(buildNuxt(indexChild, { "/dashboard/settings": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    // Vue Router selects the static `/users/public` before the dynamic `/users/:id()`.
    const staticPage: Page[] = [{ path: "/users/:id()", meta: { auth: "user" } }, { path: "/users/public", meta: { auth: false } }]
    await expect(buildNuxt(staticPage, { "/users/public": { swr: 60 } })).resolves.toBeDefined()
    await expect(buildNuxt(staticPage, { "/users/**": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
  })

  it("lets a public page keep a cache only on its own static path and payload", async () => {
    const catchAll: Page[] = [{ path: "/:pathMatch(.*)*", meta: { auth: "user" } }, { path: "/users/user-:id", meta: { auth: false } }, { path: "/about", meta: { auth: false } }]
    // Vue Router selects the guarded catch-all page for `/users/private`, because `/users/user-:id` does not match it.
    await expect(buildNuxt(catchAll, { "/users/private": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_GUARDED_PAGE_CACHED",
      message: expect.stringContaining("Route rule \"/users/private\""),
      fix: expect.stringContaining("use that exact path as the route rule key"),
    })
    // A public page with a dynamic path does not exempt a rule, also on its own path.
    await expect(buildNuxt(catchAll, { "/users/user-:id": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    await expect(buildNuxt(catchAll, { "/about": { swr: 60 }, "/about/_payload.json": { swr: 60 }, "/ABOUT": { isr: 60 } })).resolves.toBeDefined()
    await expect(buildNuxt(catchAll, { "/about/**": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
  })

  it("reads `ssr` on the paths and methods that the rule caches", async () => {
    const account: Page[] = [{ path: "/account/:id()", meta: { auth: "user" } }]
    await expect(buildNuxt(account, { "/**": { ssr: true }, "/account/preview": { ssr: false, swr: 60 } })).resolves.toBeDefined()
    await expect(buildNuxt(account, { "/**": { ssr: true }, "/account/preview": { ssr: false }, "/account/**": { swr: 60 } })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    await expect(buildNuxt(pages, { "/**": { ssr: false, swr: 60 }, "POST /dashboard": { ssr: true } })).resolves.toBeDefined()
    await expect(buildNuxt(pages, { "/**": { ssr: false, swr: 60 }, "GET /dashboard": { ssr: true } })).rejects.toMatchObject({ message: expect.stringContaining("the page \"/dashboard\"") })
  })
})

describe("Nuxt page guard of access.pages with cache route rules", () => {
  const accessPages = { "/dashboard/**": "user", "/dashboard/pricing": false, "/login": "guest" } as const
  const pagesWithoutMeta: Page[] = [
    { path: "/dashboard" },
    { path: "/dashboard/:id()" },
    { path: "/dashboard/open", meta: { auth: false } },
    { path: "/login" },
    { path: "/blog/:slug()" },
  ]
  const check = (routeRules: RouteRules, pages: Page[] = pagesWithoutMeta, access: Record<`/${string}`, "user" | "guest" | false> = accessPages) => assertNoCachedPageGuards(pages, routeRules, { accessPages: access })

  it("fails the build when a route rule caches a page that access.pages guards, or its payload", async () => {
    await expect(check({ "/dashboard/**": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_GUARDED_PAGE_CACHED",
      message: expect.stringContaining("the page \"/dashboard\", which `access.pages` \"/dashboard/**\" guards"),
    })
    await expect(check({ "/dashboard/settings": { isr: true } })).rejects.toMatchObject({ message: expect.stringContaining("the page \"/dashboard/:id()\"") })
    await expect(check({ "/login": { swr: 60 } })).rejects.toMatchObject({ message: expect.stringContaining("`access.pages` \"/login\"") })
    // Nuxt renders the payload of a page with the guard of the page path.
    await expect(check({ "/account/_payload.json": { isr: 60 } }, [{ path: "/account" }], { "/account": "user" })).rejects.toMatchObject({ message: expect.stringContaining("payload of the page \"/account\"") })
  })

  it("passes on the pages that access.pages leaves public", async () => {
    await expect(check({ "/blog/**": { swr: 60 } })).resolves.toBeUndefined()
    // A guest page renders the same for every visitor that has no cookie.
    await expect(check({ "/login": { prerender: true } })).resolves.toBeUndefined()
    // definePageMeta({ auth }) wins over access.pages.
    await expect(check({ "/dashboard/open": { swr: 60 } })).resolves.toBeUndefined()
    // `false` of a narrower pattern takes the guard off the paths that a dynamic page renders.
    await expect(check({ "/dashboard/pricing": { swr: 60 } })).resolves.toBeUndefined()
  })

  it("keeps the guard of a narrower pattern inside a `false` pattern", async () => {
    const pages: Page[] = [{ path: "/a/:rest(.*)*" }]
    const access = { "/a/**": "user", "/a/b/**": false, "/a/b/c": "user" } as const
    await expect(check({ "/a/b/d": { swr: 60 } }, pages, access)).resolves.toBeUndefined()
    await expect(check({ "/a/b/**": { swr: 60 } }, pages, access)).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
  })

  it("counts a guard that covers only some paths of a page", async () => {
    // `/team/admin` is guarded, and the `/team/:id` page renders it.
    const team: Page[] = [{ path: "/team/:id()" }]
    const admin = { "/team/admin": "user" } as const
    await expect(check({ "/team/admin": { swr: 60 } }, team, admin)).rejects.toMatchObject({ message: expect.stringContaining("`access.pages` \"/team/admin\"") })
    await expect(check({ "/team/admin/_payload.json": { swr: 60 } }, team, admin)).rejects.toMatchObject({ message: expect.stringContaining("payload of the page \"/team/:id()\"") })
    await expect(check({ "/team/other": { swr: 60 } }, team, admin)).resolves.toBeUndefined()
    // A catch-all page renders the paths of a pattern with `:name`.
    await expect(check({ "/acme/settings": { swr: 60 } }, [{ path: "/:slug(.*)*" }], { "/:org/settings": "user" })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    // The payload of a `false` page renders with the mode of the page path.
    await expect(check({ "/dashboard/pricing/_payload.json": { swr: 60 } })).resolves.toBeUndefined()
  })

  it("counts a rule that caches the payload of a guarded path", async () => {
    // `/team/admin/:file` caches `/team/admin/_payload.json`.
    await expect(check({ "/team/admin/:file": { swr: 60 } }, [{ path: "/team/admin" }], { "/team/admin": "user" })).rejects.toMatchObject({ message: expect.stringContaining("payload of the page \"/team/admin\"") })
    // A catch-all page renders `/team/admin` and its payload.
    await expect(check({ "/team/admin/_payload.json": { swr: 60 } }, [{ path: "/:slug(.*)*" }], { "/team/admin": "user" })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    await expect(check({ "/team/other/_payload.json": { swr: 60 } }, [{ path: "/:slug(.*)*" }], { "/team/admin": "user" })).resolves.toBeUndefined()
  })

  it("exempts a payload only when a false key covers the page of the payload", async () => {
    // Nuxt picks the guard of `/team/_payload.json` from `/team`, which `/team/:file` does not match.
    await expect(check({ "/team/_payload.json": { swr: 60 } }, [{ path: "/team" }], { "/**": "user", "/team/:file": false })).rejects.toMatchObject({ message: expect.stringContaining("payload of the page \"/team\"") })
    await expect(check({ "/team/:file": { swr: 60 } }, [{ path: "/:slug(.*)*" }], { "/**": "user", "/team/:file": false })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    await expect(check({ "/team/admin/_payload.json": { swr: 60 } }, [{ path: "/:slug(.*)*" }], { "/**": "user", "/team/admin": false })).resolves.toBeUndefined()
  })

  it("passes a prerender of a path whose most specific key is 'guest'", async () => {
    const access = { "/dashboard/**": "user", "/dashboard/welcome": "guest" } as const
    await expect(check({ "/dashboard/welcome": { prerender: true } }, [{ path: "/dashboard/welcome" }, { path: "/dashboard/:id()" }], access)).resolves.toBeUndefined()
    // A prerender renders without a cookie, but a cache keeps the redirect of the first signed-in visitor.
    await expect(check({ "/dashboard/welcome": { swr: 60 } }, [{ path: "/dashboard/:id()" }], access)).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
  })

  it("exempts a path only when its `false` key wins over each guarding key, as the guard orders them", async () => {
    // `/team/:id` wins over `/:org/admin` on `/team/admin`: Nuxt compares the static `team` with `:org` first.
    const access = { "/:org/admin": "user", "/team/:id": false } as const
    await expect(check({ "/team/admin": { swr: 60 } }, [{ path: "/:slug(.*)*" }], access)).resolves.toBeUndefined()
    await expect(check({ "/acme/admin": { swr: 60 } }, [{ path: "/:slug(.*)*" }], access)).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
  })

  it("reads access.pages of server/auth.ts in the build", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-page-cache-"))
    try {
      await mkdir(join(rootDir, "server"))
      await writeFile(join(rootDir, "server/auth.ts"), "import { defineAuth } from '@vite-hub/auth'\nexport default defineAuth({ access: { pages: { '/dashboard/**': 'user' } } })\n")
      await expect(buildNuxt([{ path: "/dashboard" }], { "/dashboard": { swr: 60 } }, undefined, { rootDir })).rejects.toMatchObject({ code: "AUTH_GUARDED_PAGE_CACHED" })
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
