import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatMigrationReport, formatReport, runCodemod, runMigration } from "../src/index.ts"
import { pageRoute, pathMatches } from "../src/nuxt-better-auth/pages.ts"
import { withVersionPlaceholder } from "./fixture-version.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/nuxt-better-auth-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function createApp(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [file, code] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, file)), { recursive: true })
    await writeFile(join(cwd, file), code)
  }
  return cwd
}

const serverConfig = "import { defineServerAuth } from '@nuxtjs/better-auth/config'\n\nexport default defineServerAuth({ emailAndPassword: { enabled: true } })\n"

describe("nuxt-better-auth", () => {
  it.each([
    ["nuxt.config.ts", "export default defineNuxtConfig({ vitehub: { auth: false } })", "Auth is disabled"],
    ["nuxt.config.ts", "export default defineNuxtConfig({ $production: { vitehub: { auth: false } } })", "Nuxt environment override $production"],
    ["server/auth.config.ts", serverConfig, "Multiple source server configs"],
    ["app/auth.config.ts", "export default defineClientAuth({ plugins: [twoFactorClient()] })", "only the app's app/auth.client.ts"],
  ])("leaves the app unchanged when a nested layer has %s", async (file, source, message) => {
    const config = "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth', 'vite-hub/nuxt'], extends: ['./layers/feature'], routeRules: { '/api/reports': { auth: 'user' } } })"
    const cwd = await createApp({
      "nuxt.config.ts": config,
      "server/auth.config.ts": serverConfig,
      "layers/feature/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['../../base'] })",
      "base/nuxt.config.ts": "export default defineNuxtConfig({})",
      [`base/${file}`]: source,
    })
    await expect(runCodemod("nuxt-better-auth", { cwd })).rejects.toThrow(message)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, `base/${file}`), "utf8")).toBe(source)
  })

  it.each([
    ["routeRules: { '/api/reports': { auth: { user: { role: 'admin' } } } }", "unsupported auth rule"],
    ["routeRules: { '/api/billing/*': { auth: 'user' } }", "unsupported auth path"],
    ["routeRules: { '/api/reports': { auth: 'guest' } }", "guest-only"],
    ["routeRules: { '/**': { auth: 'user' } }", "unsupported auth path"],
    ["routeRules: { '/team/staff/*': { auth: 'guest' }, '/team/*/members': { auth: 'user' } }", "unsupported auth path"],
    ["routeRules: { '/team/**': { auth: 'user' }, '/team/staff': { auth: { redirectTo: '/login' } } }", "overlap"],
    ["routeRules: { '/team/staff': { auth: { only: 'user', redirectTo: loginPath } } }", "literal redirectTo"],
    ["vitehub: { auth: false }", "Auth is disabled"],
    ["$production: { vitehub: { auth: false } }", "Nuxt environment override $production"],
    ["$env: { staging: { routeRules: { '/api/reports': { auth: 'user' } } } }", "Nuxt environment override $env"],
    ["extends: ['some-remote-layer']", "cannot verify the Auth configuration"],
    ["routeRules: { [loginPath]: { auth: 'user' } }", "routeRules are not a static object"],
  ])("leaves the app unchanged for %s", async (config, message) => {
    const source = `const loginPath = '/sign-in'\nexport default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], ${config} })\n`
    const cwd = await createApp({ "nuxt.config.ts": source, "server/auth.config.ts": serverConfig })
    await expect(runCodemod("nuxt-better-auth", { cwd })).rejects.toThrow(message)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(source)
    expect(await readFile(join(cwd, "server/auth.config.ts"), "utf8")).toBe(serverConfig)
  })

  it("leaves the app unchanged when an extends entry overrides Auth", async () => {
    const config = "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth', 'vite-hub/nuxt'], extends: [['./base', { overrides: { vitehub: { auth: false } } }]], routeRules: { '/api/reports': { auth: 'user' } } })"
    const cwd = await createApp({
      "nuxt.config.ts": config,
      "base/nuxt.config.ts": "export default defineNuxtConfig({})",
      "server/auth.config.ts": serverConfig,
    })
    await expect(runCodemod("nuxt-better-auth", { cwd })).rejects.toThrow("extends overrides")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "server/auth.config.ts"), "utf8")).toBe(serverConfig)
  })

  it.each([
    ["app/pages/admin.vue", "<script setup>definePageMeta({ auth: { user: { role: 'admin' } } })</script>\n<template><div /></template>", "cannot preserve the page auth options user"],
    ["app/pages/team/[section].vue", "<template><div /></template>", "dynamic page"],
    ["server/auth.config.ts", "export default defineServerAuth({ database: customAdapter })", "return custom storage adapters"],
    ["server/auth.config.ts", "export default defineServerAuth({ ...options })", "without spreads"],
    ["server/auth.config.ts", "export default defineServerAuth(options)", "explicit Auth options"],
    ["server/auth.config.ts", "export default defineServerAuth(function () { return {} })", "arrow function"],
    ["server/auth.config.ts", "export default defineServerAuth({ ['emailAndPassword']: { enabled: true } })", "explicit Auth options"],
    ["server/auth.config.ts", "export default defineServerAuth({ access: { routes: [] } })", "existing access option"],
    ["layers/base/server/auth.config.ts", serverConfig, "Multiple source server configs"],
    ["layers/base/app/auth.config.ts", "export default defineClientAuth({ plugins: [twoFactorClient()] })", "only the app's app/auth.client.ts"],
  ])("does not edit an app with unsupported %s", async (file, source, message) => {
    const config = "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], routeRules: { '/': { auth: 'guest' }, '/api/reports': { auth: 'user' } } })"
    const cwd = await createApp({
      "nuxt.config.ts": config,
      "server/auth.config.ts": serverConfig,
      "app/pages/index.vue": "<template><div /></template>",
      "layers/base/nuxt.config.ts": "export default defineNuxtConfig({})",
      [file]: source,
    })
    await expect(runCodemod("nuxt-better-auth", { cwd })).rejects.toThrow(message)
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, file), "utf8")).toBe(source)
  })

  it("emits a plain redirect literal without Nuxt config types in a page", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": `const loginPath = '/sign-in'\nexport default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], routeRules: { '/reports': { auth: { only: 'user', redirectTo: '/sign-in' as typeof loginPath } } } })`,
      "server/auth.config.ts": serverConfig,
      "app/pages/reports.vue": "<template><div /></template>",
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const page = run.result.edits.find(edit => edit.path === "app/pages/reports.vue")?.after
    expect(page).toContain("definePageMeta({ auth: { only: 'user', redirectTo: '/sign-in' } })")
    expect(page).not.toContain("loginPath")
  })

  it("leaves sign-in, callbacks and the exact health route outside the API guard", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], routeRules: { '/api/health': { auth: false }, '/api/**': { auth: 'user' } } })",
      "server/auth.config.ts": serverConfig,
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const definition = run.result.edits.find(edit => edit.path === "server/auth.ts")?.after
    expect(definition).toContain("access: { routes: ['/api/**'], public: ['/api/health', '/api/auth/**'] }")
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).not.toContain("routeRules")
  })

  it("does not move a catch-all guard around a custom Auth basePath", async () => {
    const config = "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], routeRules: { '/api/**': { auth: 'user' } } })"
    const definition = "export default defineServerAuth({ basePath: '/api/login' })"
    const cwd = await createApp({ "nuxt.config.ts": config, "server/auth.config.ts": definition })
    await expect(runCodemod("nuxt-better-auth", { cwd })).rejects.toThrow("custom Auth basePath")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "server/auth.config.ts"), "utf8")).toBe(definition)
  })

  it.each(["getUserSession", "getRequestSession"])("forwards cookies and preserves the optional result of %s", async (helper) => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'] })",
      "server/auth.config.ts": serverConfig,
      "server/api/session.js": `const readSession = (cookie) => ${helper}(cookie)`,
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const handler = run.result.edits.find(edit => edit.path === "server/api/session.js")?.after
    expect(handler).toBeTypeOf("string")
    const requestHeaders = new Headers()
    const responseHeaders = new Headers({ "set-cookie": "existing=1" })
    const sessionHeaders = new Headers()
    sessionHeaders.append("set-cookie", "updated=1")
    sessionHeaders.append("set-cookie", "other=1")
    const result: unknown = await runInNewContext(`${handler}\nreadSession(event)`, {
      event: { req: { headers: requestHeaders }, res: { headers: responseHeaders } },
      useAuth: () => ({ api: { getSession: (options: unknown) => {
        expect(options).toEqual({ headers: requestHeaders, returnHeaders: true })
        return Promise.resolve({ headers: sessionHeaders, response: null })
      } } }),
    })
    expect(result).toBeNull()
    expect(responseHeaders.getSetCookie()).toEqual(["existing=1", "updated=1", "other=1"])
  })

  it("migrates the Auth configs, route rules, pages, server helpers, and a layer", async () => {
    const input = join(fixtures, "nuxt-better-auth", "input")
    const run = await runCodemod("nuxt-better-auth", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(withVersionPlaceholder(edit.after)).toMatchFileSnapshot(join(fixtures, "nuxt-better-auth", "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "nuxt-better-auth", "output", "report.txt"))
  })

  it("runs after nuxthub in a full migration, and a second run finds nothing", async () => {
    await mkdir(scratch, { recursive: true })
    const cwd = await mkdtemp(join(scratch, "migrate-"))
    await cp(join(fixtures, "nuxt-better-auth", "input"), cwd, { recursive: true })
    const found = await detectCodemods(cwd)
    expect(found.map(entry => entry.codemod.name)).toEqual(["nuxthub", "nuxt-better-auth"])
    const migration = await runMigration({ cwd })
    expect(migration.steps.map(step => step.error ?? "ok")).toEqual(["ok", "ok"])
    expect(await readFile(join(cwd, "server/auth.ts"), "utf8")).toContain("database: authDatabase()")
    expect(formatMigrationReport(migration)).toContain("moved 1 Auth config to server/auth.ts")
    expect(await detectCodemods(cwd)).toEqual([])
  })

  it("detects the module in a local layer only", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({\n  extends: ['./feature'],\n})\n",
      "feature/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['../base'] })\n",
      "base/nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'] })\n",
      "base/server/auth.config.ts": serverConfig,
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("nuxt-better-auth")
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const paths = run.result.edits.map(edit => `${edit.path}${edit.after === null ? " (deleted)" : ""}`)
    expect(paths).toEqual(expect.arrayContaining(["nuxt.config.ts", "base/nuxt.config.ts", "base/server/auth.config.ts (deleted)", "base/server/auth.ts"]))
    expect(run.result.edits.find(edit => edit.path === "nuxt.config.ts")?.after).toContain("modules: ['vite-hub/nuxt'],")
    expect(run.result.edits.find(edit => edit.path === "base/nuxt.config.ts")?.after).not.toContain("better-auth")
  })

  it("rewrites a callback context identifier and keeps requestOrigin", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'], vitehub: { host: 'node', database: true } })\n",
      "server/auth.config.ts": "export default defineServerAuth((ctx) => ({\n  appName: ctx.runtimeConfig.public.appName,\n  trustedOrigins: [ctx.requestOrigin],\n}))\n",
    })
    const run = await runCodemod("nuxt-better-auth", { cwd, dryRun: true })
    const definition = run.result.edits.find(edit => edit.path === "server/auth.ts")?.after
    expect(definition).toBe([
      "import { defineAuth } from \"vite-hub/auth\"",
      "import { useRuntimeConfig } from \"nitro/runtime-config\"",
      "import { authDatabase } from \"vite-hub/auth/database\"",
      "",
      "export default defineAuth((ctx) => ({",
      "  database: authDatabase(),",
      "  appName: useRuntimeConfig().public.appName,",
      "  trustedOrigins: [ctx.requestOrigin],",
      "}))",
      "",
    ].join("\n"))
  })

  it("stops without edits when no server config can move", async () => {
    const cwd = await createApp({
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxtjs/better-auth'] })\n",
      "server/auth.config.ts": "export default createConfig()\n",
    })
    await expect(runCodemod("nuxt-better-auth", { cwd, dryRun: true })).rejects.toThrow("No server/auth.config.ts with defineServerAuth() could be moved")
  })
})

describe("nuxt-better-auth route matching", () => {
  it.each([
    ["index.vue", "/"],
    ["dashboard/index.vue", "/dashboard"],
    ["dashboard/[id].vue", "/dashboard/:id"],
    ["(marketing)/about.vue", "/about"],
    ["docs/[...slug].vue", "/docs/**"],
  ])("maps %s to %s", (file, route) => {
    expect(pageRoute(file)).toBe(route)
  })

  it("matches whole path segments", () => {
    expect(pathMatches("/app/**", "/app")).toBe(true)
    expect(pathMatches("/app/**", "/app/settings")).toBe(true)
    expect(pathMatches("/app/**", "/apple")).toBe(false)
    expect(pathMatches("/app", "/app/settings")).toBe(false)
  })
})
