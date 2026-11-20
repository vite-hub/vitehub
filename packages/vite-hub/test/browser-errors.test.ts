import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createBrowserErrorsHandler, parseBrowserErrorReport } from "../src/_internal/runtime/browser-errors.ts"
import { browserErrorsNuxtPluginSource, browserErrorsReporterSource, browserErrorsVitePlugin, installBrowserErrorsNuxt } from "../src/browser-errors-vite.ts"
import { viteHubPlugins } from "../src/plugins.ts"

import type { Plugin } from "vite"

const origin = "https://shop.example"
const report = { kind: "error", path: "/orders", name: "TypeError", message: "x is undefined", stack: "TypeError: x is undefined\n    at pay (https://shop.example/_nuxt/pay.js:1:20)" }

function post(body: unknown, headers: Record<string, string> = { origin, "sec-fetch-site": "same-origin" }, log?: { error: (error: Error, fields: Record<string, unknown>) => void }) {
  const request = new Request(`${origin}/_vitehub/browser-errors`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  // Evlog's Nitro plugin puts the request logger here.
  if (log) Object.assign(request, { context: { log: { set: vi.fn(), warn: vi.fn(), ...log } } })
  return request
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("browser error ingest", () => {
  it("writes a same-origin report into the request's Evlog event", async () => {
    const error = vi.fn()
    const response = await createBrowserErrorsHandler().fetch(post(report, undefined, { error }))
    expect(response.status).toBe(204)
    expect(error).toHaveBeenCalledOnce()
    const [logged, fields] = error.mock.calls[0]!
    expect(logged).toBeInstanceOf(Error)
    expect(logged).toMatchObject({ name: "TypeError", message: "x is undefined", stack: report.stack })
    expect(fields).toEqual({ browserError: { kind: "error", path: "/orders" } })
  })

  it("logs to the server console when the request has no Evlog logger", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await createBrowserErrorsHandler().fetch(post(report))).status).toBe(204)
    expect(consoleError).toHaveBeenCalledWith("[vitehub] Browser error", expect.objectContaining({ message: "x is undefined" }))
  })

  it("refuses reports from other sites and from clients without an Origin", async () => {
    const handler = createBrowserErrorsHandler()
    expect((await handler.fetch(post(report, { origin: "https://evil.example" }))).status).toBe(403)
    expect((await handler.fetch(post(report, { origin, "sec-fetch-site": "cross-site" }))).status).toBe(403)
    expect((await handler.fetch(post(report, {}))).status).toBe(403)
  })

  it("refuses a body over 16 KiB", async () => {
    const response = await createBrowserErrorsHandler().fetch(post({ ...report, stack: "a".repeat(17 * 1024) }))
    expect(response.status).toBe(413)
  })

  it("stops reading a streamed body at 16 KiB", async () => {
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(4 * 1024).fill(97)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request(`${origin}/_vitehub/browser-errors`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body,
      duplex: "half",
    })
    expect(request.headers.get("content-length")).toBeNull()
    expect((await createBrowserErrorsHandler().fetch(request)).status).toBe(413)
    expect(cancelled).toBe(true)
    // Five 4 KiB chunks pass the limit; the stream may pull one more ahead.
    expect(pulled).toBeLessThanOrEqual(6)
  })

  it("refuses a body that is not a report", async () => {
    const handler = createBrowserErrorsHandler()
    expect((await handler.fetch(post("{"))).status).toBe(400)
    expect((await handler.fetch(post({ ...report, kind: "toast" }))).status).toBe(400)
    expect((await handler.fetch(post({ ...report, path: "https://shop.example/orders" }))).status).toBe(400)
  })

  it("takes 20 reports a minute from one address", async () => {
    let now = 0
    const handler = createBrowserErrorsHandler(() => now)
    vi.spyOn(console, "error").mockImplementation(() => {})
    for (let index = 0; index < 20; index++) expect((await handler.fetch(post(report))).status).toBe(204)
    const refused = await handler.fetch(post(report))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("60")
    now = 60_000
    expect((await handler.fetch(post(report))).status).toBe(204)
  })

  it("removes queries from the path and from URLs in the text, and cuts each field", () => {
    expect(parseBrowserErrorReport({
      ...report,
      path: "/callback?code=secret#top",
      message: `Failed to fetch https://shop.example/api/orders?token=abc. Why? ${"x".repeat(2000)}`,
    })).toEqual({
      kind: "error",
      path: "/callback",
      name: "TypeError",
      message: `Failed to fetch https://shop.example/api/orders Why? ${"x".repeat(2000)}`.slice(0, 1000),
      stack: report.stack,
    })
  })
})

describe("browser error reporter", () => {
  it("is off unless observability.browserErrors is set", () => {
    const names = (options: Parameters<typeof viteHubPlugins>[0]) => viteHubPlugins(options).flat(3).filter((plugin): plugin is Plugin => Boolean(plugin && typeof plugin === "object" && "name" in plugin)).map(plugin => plugin.name)
    expect(names({ host: "node", logs: true })).not.toContain("vite-hub/browser-errors")
    expect(names({ host: "node", observability: { browserErrors: true } })).toContain("vite-hub/browser-errors")
  })

  it("mounts the route below the app base and points the page script at it", () => {
    const plugin = browserErrorsVitePlugin()
    const config: Record<string, unknown> = { base: "/shop/" }
    plugin.config(config)
    expect(config.nitro).toMatchObject({ handlers: [expect.objectContaining({ method: "POST", route: "/shop/_vitehub/browser-errors" })] })
    const [tag] = plugin.transformIndexHtml()
    expect(tag!.children).toContain(`const endpoint = "/shop/_vitehub/browser-errors"`)
  })

  it("reports each message once, at most 10 times a page load, without the query", async () => {
    const listeners = new Map<string, (event: { error?: unknown, reason?: unknown }) => void>()
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const run = new Function("addEventListener", "fetch", "location", browserErrorsReporterSource(JSON.stringify("/_vitehub/browser-errors")))
    run((name: string, listener: (event: { error?: unknown, reason?: unknown }) => void) => listeners.set(name, listener), fetch, { pathname: "/orders" })
    listeners.get("error")!({ error: new TypeError("x is undefined") })
    listeners.get("error")!({ error: new TypeError("x is undefined") })
    // A failed image load has no error object.
    listeners.get("error")!({})
    listeners.get("unhandledrejection")!({ reason: Object.assign(new Error("aborted"), { name: "AbortError" }) })
    for (let index = 0; index < 20; index++) listeners.get("unhandledrejection")!({ reason: `failure ${index}` })
    expect(fetch).toHaveBeenCalledTimes(10)
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe("/_vitehub/browser-errors")
    expect(init).toMatchObject({ method: "POST", keepalive: true })
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: "error", path: "/orders", name: "TypeError", message: "x is undefined" })
  })

  it("adds a Nuxt client plugin that also reports Vue and Nuxt errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-browser-errors-"))
    try {
      const nuxt: { options: { plugins?: Array<string | { src: string }> } } = { options: {} }
      await installBrowserErrorsNuxt(nuxt, root)
      await installBrowserErrorsNuxt(nuxt, root)
      const plugin = join(root, ".vitehub/browser-errors/nuxt-plugin.client.mjs")
      expect(nuxt.options.plugins).toEqual([plugin])
      const source = await readFile(plugin, "utf8")
      expect(source).toBe(browserErrorsNuxtPluginSource())
      expect(source).toContain(`nuxtApp.hook("vue:error", error => report("vue", error))`)
      expect(source).toContain(`nuxtApp.hook("app:error", error => report("nuxt", error))`)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
