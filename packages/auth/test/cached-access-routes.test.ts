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

/** Installs the Nitro modules of the config as Nitro does, then runs the hook that Nitro calls before it builds. */
async function buildNitro(nitro: Record<string, unknown>, routeRules: Record<string, Record<string, unknown>>, baseURL = "/"): Promise<void> {
  const hooks: Array<() => unknown> = []
  const instance = {
    hooks: { hook: (name: string, callback: () => unknown) => { if (name === "build:before") hooks.push(callback) } },
    options: { baseURL, routeRules },
  }
  const modules = Array.isArray(nitro.modules) ? nitro.modules : []
  for (const module of modules) await (module as { setup: (nitro: typeof instance) => unknown }).setup(instance)
  for (const hook of hooks) await hook()
}

async function buildViteApp(routes: string[], routeRules: Record<string, Record<string, unknown>>, baseURL?: string): Promise<void> {
  const root = await createProject(routes)
  await buildNitro(createAuthNitroConfig(hubAuth(), { nitro: {}, projectRoot: root }), routeRules, baseURL)
}

describe("Auth access routes with cache route rules", () => {
  it("fails the build when an swr rule caches a guarded route", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/dashboard/**": { swr: 60 } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("Route rule \"/dashboard/**\" sets `cache` on \"/dashboard\""),
      fix: expect.stringContaining("cache: false"),
    })
  })

  it("fails the build when a prerender rule covers a guarded route", async () => {
    await expect(buildViteApp(["'/account'"], { "/**": { prerender: true } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("Route rule \"/**\" sets `prerender` on \"/account\""),
    })
  })

  it("fails the build when a rule caches a path below a guarded route", async () => {
    await expect(buildViteApp(["'/admin/**'"], { "/admin/:id/report": { isr: 60 } })).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("sets `isr` on \"/admin/_/report\""),
    })
  })

  it("reads access routes and route rules below the Nitro base URL", async () => {
    await expect(buildViteApp(["'/dashboard/**'"], { "/dashboard/**": { swr: 60 } }, "/portal/")).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("sets `cache` on \"/portal/dashboard\""),
    })
    await expect(buildViteApp(["'/portal/admin/**'"], { "/admin/**": { swr: 60 } }, "/portal/")).rejects.toMatchObject({ code: "AUTH_B0002" })
    await expect(buildViteApp(["'/portal/admin/**'"], { "/blog/**": { swr: 60 } }, "/portal/")).resolves.toBeUndefined()
    // Nitro mounts every rule key below the base URL, also a key that starts with it: this rule caches "/portal/portal/report".
    await expect(buildViteApp(["'/portal/**'"], { "/portal/report": { swr: 60 } }, "/portal/")).rejects.toMatchObject({
      code: "AUTH_B0002",
      message: expect.stringContaining("sets `cache` on \"/portal/portal/report\""),
    })
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
