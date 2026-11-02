import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { installViteHubPageTools, registerViteHubPageTool } from "@vite-hub/internal/runtime/page-tools"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import pageSessionHandler from "../src/console/runtime/server/page-session.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"

import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"

const policyKey = Symbol.for("vitehub.console.access")
const pageToolsKey = Symbol.for("vitehub.page-tools")

function sessionApp() {
  return { fetch: (request: Request) => pageSessionHandler({ method: "GET", req: request }) }
}

/** The tools that the page tools session allows for one page request under a Console access policy. */
async function sessionTools(policy: ConsoleAccessPolicy | undefined, headers: Record<string, string> = {}, base = "", app = sessionApp()) {
  if (policy) installConsoleAccess(policy)
  else Reflect.deleteProperty(globalThis, policyKey)
  installConsolePageTool(app, { base })
  const request = new Request(`http://site.test${base}/_vitehub/page/session`, { headers })
  const response = await app.fetch(request)
  const body: unknown = await response.json()
  return { body, cookie: response.headers.get("set-cookie") }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, policyKey)
  Reflect.deleteProperty(globalThis, pageToolsKey)
  for (const suffix of ["", ".root", ".registry", ".ambiguous-root"]) Reflect.deleteProperty(globalThis, Symbol.for(`vitehub.console.development${suffix}`))
  vi.unstubAllEnvs()
})

describe("the Console page tool", () => {
  it.each(["comments-first", "console-first"])("excludes mounted Console and API pages regardless of installation order (%s)", async (order) => {
    const html = "<body>Page</body>"
    const app = { fetch: (_request: Request) => new Response(html, { headers: { "content-type": "text/html" } }) }
    registerViteHubPageTool(app, { id: "comments", label: "Comments", icon: "comments", script: "/comments.js", allowed: async () => true })
    if (order === "comments-first") installViteHubPageTools(app)
    installConsolePageTool(app, { base: "/portal/" })
    if (order === "console-first") installViteHubPageTools(app)
    for (const path of ["/portal/_vitehub", "/portal/_vitehub/", "/portal/_vitehub/comments", "/portal/api", "/portal/api/data", "/_vitehub", "/api/data"]) {
      const response = await app.fetch(new Request(`http://site.test${path}?vitehub`, { headers: { cookie: "vitehub-tools=1" } }))
      expect(await response.text()).toBe(html)
      expect(response.headers.get("cache-control")).toBeNull()
    }
    expect(await (await app.fetch(new Request("http://site.test/portal/pricing?vitehub"))).text()).toContain("data-vitehub-page-tools")
  })

  it("is allowed for people that the Console access policy accepts, for any section", async () => {
    const { body, cookie } = await sessionTools({ mode: "open" })
    expect(body).toEqual({ tools: [{ id: "console", label: "Console", icon: "i-lucide-square-terminal", lazy: true, script: "/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__" }] })
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

  it("keeps other allowed tools when Console access is missing or denied", async () => {
    const comments = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/comments.js" }
    const app = sessionApp()
    registerViteHubPageTool(app, { ...comments, allowed: async () => true })

    const expected = { body: { tools: [comments] }, cookie: expect.stringContaining("vitehub-tools=1") }
    await expect(sessionTools(undefined, {}, undefined, app)).resolves.toEqual(expected)
    await expect(sessionTools({ mode: "open", authorize: async () => false }, {}, undefined, app)).resolves.toEqual(expected)
  })

  it("is allowed in local mode only on the development server", async () => {
    installConsoleDevelopment("/test/app", false)
    await expect(sessionTools({ mode: "local" })).resolves.toMatchObject({ body: { tools: [] } })
    installConsoleDevelopment("/test/app", true)
    await expect(sessionTools({ mode: "local" })).resolves.toMatchObject({ body: { tools: [{ id: "console" }] } })
  })

  it("is not registered while no Console output installed it", async () => {
    installConsoleAccess({ mode: "open" })
    const request = new Request("http://site.test/_vitehub/page/session")
    const app = sessionApp()
    installViteHubPageTools(app)
    await expect((await app.fetch(request)).json()).resolves.toEqual({ tools: [] })
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

  it("keeps page tools out of RPC-only development output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rpc-only-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ rpcOnly: true, preset: "node", sections: [] })
      const hook = plugin.config!
      const handler = "handler" in hook ? hook.handler : hook
      const config: { root: string, nitro?: { handlers: Array<{ route: string }>, publicAssets: Array<{ baseURL: string }> } } = { root }
      await Reflect.apply(handler, {}, [config, { command: "serve", mode: "development" }])
      expect(config.nitro?.handlers.some(handler => handler.route.includes("/page/session"))).toBe(false)
      expect(config.nitro?.publicAssets.some(asset => asset.baseURL.includes("/_vitehub/"))).toBe(false)
      await expect(readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).resolves.toContain("export default function viteHubConsolePlugin() {}")
      const htmlHook = plugin.transformIndexHtml
      const transform = typeof htmlHook === "function" ? htmlHook : htmlHook?.handler
      if (transform) expect(await Reflect.apply(transform, undefined, ["", { path: "/", filename: join(root, "index.html") }])).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    ["/", ""],
    ["/portal/", "/portal"],
    ["https://site.test/portal/", ""],
    ["./", ""],
  ])("serves the page tools and Console below Vite base %s", async (base, path) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tools-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false }, preset: "node", sections: [] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { handlers: Array<{ handler: string, route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { base, root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers).toContainEqual({ handler: expect.stringMatching(/server[/\\]page-session\.js$/), route: `${path}/_vitehub/page/session` })
      expect(config.nitro?.publicAssets).toContainEqual(expect.objectContaining({ baseURL: `${path}/_vitehub/page/assets`, dir: expect.stringMatching(/runtime[/\\]page$/) }))
      expect(config.nitro?.publicAssets).toContainEqual(expect.objectContaining({ baseURL: `${path}/_vitehub/assets`, dir: expect.stringMatching(/public[/\\]console$/) }))
      await expect(readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).resolves.toContain(`installConsolePageTool(nitroApp, { base: ${JSON.stringify(path || "/")} })`)
      await expect(sessionTools({ mode: "open" }, {}, path)).resolves.toMatchObject({
        body: { tools: [{ id: "console", script: `${path}/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__` }] },
      })
      // A single page app gets one loader below the base, also with Comments.
      const transform = plugin.transformIndexHtml as (html: string) => string | undefined
      const page = transform("<html><body></body></html>")
      expect(page).toContain(`import("${path}/_vitehub/page/assets/loader.js?v=10")`)
      expect(transform(page!)).toBeUndefined()
      const script = page?.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]
      if (!script) throw new TypeError("Expected a page tools loader script")
      for (const [search, cookie, imports] of [
        ["?vitehub", "", 1],
        ["?vitehub=comments", "", 1],
        ["", "session=ada; vitehub-tools=1", 1],
        ["", "", 0],
        ["?other=1", "vitehub-tools=0", 0],
      ] as const) {
        const load = vi.fn()
        // Replace only the dynamic import so the browser's hint gate runs without fetching a browser module.
        runInNewContext(script.replace("import(", "load("), { URLSearchParams, location: { search }, document: { cookie }, load })
        expect(load).toHaveBeenCalledTimes(imports)
        if (imports) expect(load).toHaveBeenCalledWith(`${path}/_vitehub/page/assets/loader.js?v=10`)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("the Console below a Nitro baseURL", () => {
  it.each([false, { server: "./console-auth.ts" }] as const)("leaves the base to Nitro, including MCP discovery with auth %j", async (auth) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-page-tools-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "console-auth.ts"), "export default {}")
      const plugin = consoleVitePlugin({ console: { auth }, preset: "node", sections: [] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { baseURL?: string, handlers: Array<{ handler: string, route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { base: "/portal/", nitro: { baseURL: "/portal/", handlers: [], publicAssets: [] }, root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      const routes = config.nitro?.handlers.map(handler => handler.route)
      expect(routes).toContain("/_vitehub/**")
      expect(routes).toContain("/_vitehub/rpc/**")
      expect(routes).toContain("/_vitehub/mcp")
      expect(routes).toContain("/_vitehub/page/session")
      if (auth) {
        expect(routes).toContain("/.well-known/oauth-protected-resource")
        expect(routes).toContain("/.well-known/oauth-authorization-server")
      }
      expect(routes?.some(route => route.startsWith("/portal/"))).toBe(false)
      expect(config.nitro?.publicAssets.map(asset => asset.baseURL)).toEqual(["/_vitehub/assets", "/_vitehub/.well-known/skills", "/_vitehub/page/assets"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("the Console page tool below an app base", () => {
  it("links to the Console assets below the base of the session route", async () => {
    const { body } = await sessionTools({ mode: "open" }, {}, "/portal")
    expect(body).toMatchObject({ tools: [{ id: "console", script: "/portal/_vitehub/assets/__VITEHUB_CONSOLE_PAGE_TOOL_ASSET__" }] })
  })
})
