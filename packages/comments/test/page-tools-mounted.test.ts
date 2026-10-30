import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compileFunction } from "node:vm"

import { H3 } from "h3"
import { describe, expect, it, vi } from "vitest"

import { defineComments } from "../src/index.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { viteHubPageSessionHandler } from "../src/runtime/index.ts"
import { hubComments } from "../src/vite.ts"

import type { UserConfig } from "vite"

describe("mounted page tools", () => {
  it.each([
    { base: "/", mount: "" },
    { base: "/portal/", mount: "/portal" },
    { base: "/portal/team/", mount: "/portal/team" },
    { base: "https://cdn.example/portal/", mount: "" },
    { base: "/_nuxt/", __vitehubAppBaseURL: "/portal/", mount: "/portal" },
  ])("loads the injected and SPA loader and executes its session request: %j", async ({ mount, ...bases }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-page-tools-"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "server/comments.ts"), "export const comments = defineComments()\n")
      const config: UserConfig & { nitro?: { handlers: Array<{ route: string }>, publicAssets: Array<{ baseURL: string, dir: string }> } } = { root, ...bases }
      const plugin = hubComments()
      const hook = plugin.config
      if (!hook) throw new Error("Expected a config hook")
      await Reflect.apply(typeof hook === "function" ? hook : hook.handler, {}, [config, { command: "build", mode: "production" }])
      const sessionRoute = config.nitro!.handlers.find(handler => handler.route.endsWith("/_vitehub/page/session"))!.route
      const asset = config.nitro!.publicAssets.find(asset => asset.baseURL?.endsWith("/_vitehub/page/assets"))!
      expect(sessionRoute).toBe(`${mount}/_vitehub/page/session`)
      expect(asset.baseURL).toBe(`${mount}/_vitehub/page/assets`)
      // Deny access so the real browser loader stops after the visitor check, without needing an overlay DOM.
      const authorize = vi.fn(() => false)
      const app = new H3()
        .get(sessionRoute, viteHubPageSessionHandler)
        .get(`${asset.baseURL}/loader.js`, async () => new Response(await readFile(join(asset.dir, "loader.js"), "utf8")))
        .get(`${mount}/guide`, () => new Response("<body>Guide</body>", { headers: { "content-type": "text/html" } }))
      defineCommentsPlugin({ comments: defineComments({ authorize }), database: () => undefined, overlay: "/api/_vitehub/comments/assets/overlay.js", base: mount })(app)
      const pageURL = `https://site.test${mount}/guide?vitehub`
      const html = await (await app.fetch(new Request(pageURL))).text()
      const src = /src="([^"]+)"/.exec(html)?.[1]
      expect(src).toBe(`${mount}/_vitehub/page/assets/loader.js?v=8`)
      const fetch = vi.fn(async (path: string, init?: RequestInit) => app.fetch(new Request(new URL(path, pageURL), init)))
      const executeLoader = async (url: string) => {
        const response = await app.fetch(new Request(new URL(url, pageURL)))
        expect(response.status).toBe(200)
        const script = await response.text()
        // Give the built module its browser URL and page hint while executing it in Node.
        compileFunction(script.replaceAll("import.meta.url", JSON.stringify(new URL(url, pageURL).href)), ["fetch", "location", "document"])(fetch, new URL(pageURL), { cookie: "" })
      }
      await executeLoader(src!)
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
      expect(fetch).toHaveBeenLastCalledWith(sessionRoute, { credentials: "same-origin", headers: { accept: "application/json" } })

      const transform = plugin.transformIndexHtml
      if (!transform) throw new Error("Expected a transformIndexHtml hook")
      const page: unknown = await Reflect.apply(typeof transform === "function" ? transform : transform.handler, {}, ["<body>Guide</body>"])
      if (typeof page !== "string") throw new Error("Expected transformed SPA HTML")
      const inline = /<script type="module" data-vitehub-page-tools>(.*?)<\/script>/.exec(page)?.[1]
      if (!inline) throw new Error("Expected the SPA loader check")
      // Substitute only the dynamic import boundary; execute the SPA's actual hint and URL selection.
      const load = vi.fn(executeLoader)
      compileFunction(inline.replace("import(", "load("), ["location", "document", "load"])(new URL(pageURL), { cookie: "" }, load)
      expect(load).toHaveBeenCalledWith(src)
      await load.mock.results[0]!.value
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2))
    }
    finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
