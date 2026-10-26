import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"

const policyKey = Symbol.for("vitehub.console.access")
const pageToolsKey = Symbol.for("vitehub.page-tools")

/** The tools that the page tools session allows for one page request under a Console access policy. */
async function sessionTools(policy: ConsoleAccessPolicy, headers: Record<string, string> = {}) {
  installConsoleAccess(policy)
  installConsolePageTool({})
  const request = new Request("http://site.test/_vitehub/page/session", { headers })
  const response = await respondViteHubPageSession(request, { method: "GET", req: request })
  const body: unknown = await response.json()
  return { body, cookie: response.headers.get("set-cookie") }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, policyKey)
  Reflect.deleteProperty(globalThis, pageToolsKey)
  vi.unstubAllEnvs()
})

describe("the Console page tool", () => {
  it("is allowed for people that the Console access policy accepts, for any section", async () => {
    const { body, cookie } = await sessionTools({ mode: "open" })
    expect(body).toEqual({ tools: [{ id: "console", label: "Console", icon: "i-lucide-square-terminal", script: "/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__" }] })
    expect(cookie).toContain("vitehub-tools=1")
    await expect(sessionTools({ mode: "open", authorize: async () => ({ sections: ["kv"] }) })).resolves.toMatchObject({ body: { tools: [{ id: "console" }] } })
  })

  it("is denied when the Console access policy rejects the request", async () => {
    await expect(sessionTools({ mode: "open", authorize: async () => false })).resolves.toMatchObject({ body: { tools: [] }, cookie: expect.stringContaining("Max-Age=0") })
    await expect(sessionTools({ mode: "open", authorize: async () => ({ sections: [] }) })).resolves.toMatchObject({ body: { tools: [] } })
    const check = async () => Response.json({ ok: false }, { status: 401 })
    await expect(sessionTools({ mode: "auth", check })).resolves.toMatchObject({ body: { tools: [] } })
    await expect(sessionTools({ mode: "cloudflare-access", check })).resolves.toMatchObject({ body: { tools: [] } })
  })

  it("is allowed for a signed-in Console user", async () => {
    const check = async (event: { req?: { headers?: { get(name: string): string | null } } }) => event.req?.headers?.get("cookie") === "session=ada" ? undefined : Response.json({ ok: false }, { status: 401 })
    await expect(sessionTools({ mode: "auth", check }, { cookie: "session=ada" })).resolves.toMatchObject({ body: { tools: [{ id: "console" }] } })
  })

  it("is allowed in local mode only on the development server", async () => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(sessionTools({ mode: "local" })).resolves.toMatchObject({ body: { tools: [] } })
    vi.stubEnv("NODE_ENV", "development")
    await expect(sessionTools({ mode: "local" })).resolves.toMatchObject({ body: { tools: [{ id: "console" }] } })
  })

  it("is not registered while no Console output installed it", async () => {
    installConsoleAccess({ mode: "open" })
    const request = new Request("http://site.test/_vitehub/page/session")
    await expect((await respondViteHubPageSession(request, { req: request })).json()).resolves.toEqual({ tools: [] })
  })
})

describe("the Console Nitro configuration", () => {
  it("serves the page tools session and loader in an app without Comments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tools-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false }, preset: "node", sections: [] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ handler: string, route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers).toContainEqual({ handler: expect.stringMatching(/server[/\\]page-session\.js$/), route: "/_vitehub/page/session" })
      expect(config.nitro?.publicAssets).toContainEqual(expect.objectContaining({ baseURL: "/_vitehub/page/assets", dir: expect.stringMatching(/runtime[/\\]page$/) }))
      // The generated Console plugin registers the `console` page tool when the Nitro app starts.
      await expect(readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).resolves.toContain("export default function viteHubConsolePlugin(nitroApp) { installConsolePageTool(nitroApp, { base: \"/\" }) }")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serves the page tools below the Vite base, as it serves the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tools-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false }, preset: "node", sections: [] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { handlers: Array<{ handler: string, route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { base: "/portal/", root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers).toContainEqual({ handler: expect.stringMatching(/server[/\\]page-session\.js$/), route: "/portal/_vitehub/page/session" })
      expect(config.nitro?.publicAssets).toContainEqual(expect.objectContaining({ baseURL: "/portal/_vitehub/page/assets" }))
      await expect(readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).resolves.toContain("installConsolePageTool(nitroApp, { base: \"/portal/\" })")
      // A single page app gets one loader below the base, also with Comments.
      const transform = plugin.transformIndexHtml as (html: string) => string | undefined
      const page = transform("<html><body></body></html>")
      expect(page).toContain("import(\"/portal/_vitehub/page/assets/loader.js?v=3\")")
      expect(transform(page!)).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("the Console below a Nitro baseURL", () => {
  it("leaves the base to Nitro, so the Console and the page tools are served once below it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tools-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false }, preset: "node", sections: [] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { baseURL?: string, handlers: Array<{ handler: string, route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { base: "/portal/", nitro: { baseURL: "/portal/", handlers: [], publicAssets: [] }, root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      const routes = config.nitro?.handlers.map(handler => handler.route)
      expect(routes).toContain("/_vitehub/**")
      expect(routes).toContain("/_vitehub/rpc/**")
      expect(routes).toContain("/_vitehub/page/session")
      expect(routes?.some(route => route.startsWith("/portal/"))).toBe(false)
      expect(config.nitro?.publicAssets.map(asset => asset.baseURL)).toEqual(["/_vitehub/assets", "/_vitehub/page/assets"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("the Console page tool below an app base", () => {
  it("links to the Console assets below the base of the session route", async () => {
    installConsoleAccess({ mode: "open" })
    installConsolePageTool({}, { base: "/portal/" })
    const request = new Request("http://site.test/portal/_vitehub/page/session")
    const body: unknown = await (await respondViteHubPageSession(request, { req: request })).json()
    expect(body).toMatchObject({ tools: [{ id: "console", script: "/portal/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__" }] })
  })
})
