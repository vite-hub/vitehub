import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createBrowserErrorsHandler, parseBrowserErrorReport } from "../src/_internal/runtime/browser-errors.ts"
import { browserErrorsNuxtPluginSource, browserErrorsReporterSource, browserErrorsVitePlugin, installBrowserErrorsNuxt } from "../src/browser-errors-vite.ts"
import { reportBrowserError } from "../src/logs/client.ts"
import { viteHubPlugins } from "../src/plugins.ts"

import type { Plugin } from "vite"

const origin = "https://shop.example"
const report = { kind: "error", path: "/orders", name: "TypeError", message: "x is undefined", stack: "TypeError: x is undefined\n    at pay (https://shop.example/_nuxt/pay.js:1:20)" }

type Log = { error?: (error: Error, fields: Record<string, unknown>) => void, warn?: (message: string, fields: Record<string, unknown>) => void }

function post(body: unknown, headers: Record<string, string> = { origin, "sec-fetch-site": "same-origin" }, log?: Log) {
  const request = new Request(`${origin}/_vitehub/browser-errors`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  // Evlog's Nitro plugin puts the request logger here.
  if (log) Object.assign(request, { context: { log: { set: vi.fn(), warn: vi.fn(), error: vi.fn(), ...log } } })
  return request
}

type Listener = (event: { error?: unknown, reason?: unknown, payload?: unknown }) => void

function tabStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

function runReporter(path = "/orders", sessionStorage: unknown = tabStorage()) {
  const listeners = new Map<string, Listener>()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
  const run = new Function("addEventListener", "fetch", "location", "sessionStorage", browserErrorsReporterSource(JSON.stringify("/_vitehub/browser-errors")))
  run((name: string, listener: Listener) => listeners.set(name, listener), fetch, { pathname: path }, sessionStorage)
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>)
  return { listeners, fetch, bodies }
}

function runNuxtPlugin(storage = tabStorage()) {
  const hooks = new Map<string, (payload: unknown) => void>()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
  const source = browserErrorsNuxtPluginSource().replace(/^import .*$/m, "").replace("export default", "return")
  const plugin = new Function("defineNuxtPlugin", "useRuntimeConfig", "addEventListener", "fetch", "location", "sessionStorage", source)(
    (definition: unknown) => definition,
    () => ({ app: { baseURL: "/shop/" } }),
    () => {},
    fetch,
    { pathname: "/orders" },
    storage,
  ) as { setup: (nuxtApp: { hook: (name: string, hook: (payload: unknown) => void) => void }) => void }
  plugin.setup({ hook: (name, hook) => hooks.set(name, hook) })
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>)
  return { hooks, fetch, bodies }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, Symbol.for("vite-hub.browserErrors"))
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
    expect(fields).toEqual({ browserError: { kind: "error", path: "/orders", level: "error" } })
  })

  it("writes a caught error with its action and fields", async () => {
    const error = vi.fn()
    const body = { ...report, kind: "handled", action: "save-order", fields: { status: 503, requestId: "req_42", orderId: "ord_7", retried: false, coupon: null } }
    expect((await createBrowserErrorsHandler().fetch(post(body, undefined, { error }))).status).toBe(204)
    expect(error.mock.calls[0]![1]).toEqual({
      browserError: { kind: "handled", path: "/orders", level: "error", action: "save-order", fields: { status: 503, requestId: "req_42", orderId: "ord_7", retried: false, coupon: null } },
    })
  })

  it("writes a warning at warn level", async () => {
    const error = vi.fn()
    const warn = vi.fn()
    const body = { kind: "handled", path: "/orders", name: "Error", message: "Sync is slow", level: "warn", action: "sync" }
    expect((await createBrowserErrorsHandler().fetch(post(body, undefined, { error, warn }))).status).toBe(204)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("Sync is slow", { browserError: { kind: "handled", path: "/orders", level: "warn", action: "sync" } })
  })

  it("logs an uncaught error at error level, whatever level the page sends", () => {
    expect(parseBrowserErrorReport({ ...report, level: "warn" })).toMatchObject({ kind: "error", level: "error" })
    expect(parseBrowserErrorReport({ ...report, kind: "handled", level: "info" })).toMatchObject({ kind: "handled", level: "error" })
  })

  it("keeps the report and drops the fields that are nested, extra, or badly named", async () => {
    const handled = { ...report, kind: "handled" }
    const fields = (body: Record<string, unknown>) => {
      const parsed = parseBrowserErrorReport(body)
      return { fields: parsed?.fields, droppedFields: parsed?.droppedFields }
    }
    expect(fields({ ...handled, fields: { status: 503, order: { id: 1 }, ids: [1, 2], ratio: Number.NaN, "bad key": 1, [`k${"x".repeat(40)}`]: 1 } }))
      .toEqual({ fields: { status: 503 }, droppedFields: 5 })
    expect(fields({ ...handled, fields: Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`field${index}`, index])) }))
      .toEqual({ fields: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, index])), droppedFields: 2 })
    expect(fields({ ...handled, fields: ["status"] })).toEqual({ fields: undefined, droppedFields: 1 })
    expect(fields({ ...handled, fields: { status: 503 }, droppedFields: 2 })).toEqual({ fields: { status: 503 }, droppedFields: 2 })
    expect(fields({ ...handled, droppedFields: -1 })).toEqual({ fields: undefined, droppedFields: undefined })
    expect(parseBrowserErrorReport({ ...handled, action: 42 })).toMatchObject({ kind: "handled", message: "x is undefined" })
    expect(parseBrowserErrorReport({ ...handled, action: 42 })?.action).toBeUndefined()

    const error = vi.fn()
    const response = await createBrowserErrorsHandler().fetch(post({ ...handled, fields: { status: 503, order: { id: 1 } } }, undefined, { error }))
    expect(response.status).toBe(204)
    expect(error.mock.calls[0]![1]).toEqual({ browserError: { kind: "handled", path: "/orders", level: "error", fields: { status: 503 }, droppedFields: 1 } })
  })

  it("cuts long field values and removes their queries", () => {
    const parsed = parseBrowserErrorReport({ ...report, kind: "handled", action: "a".repeat(200), fields: { url: "https://shop.example/api/orders?token=abc", note: "n".repeat(500) } })
    expect(parsed?.action).toBe("a".repeat(100))
    expect(parsed?.fields).toEqual({ url: "https://shop.example/api/orders", note: "n".repeat(300) })
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
      level: "error",
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
    const { listeners, fetch } = runReporter()
    listeners.get("error")!({ error: new TypeError("x is undefined") })
    listeners.get("error")!({ error: new TypeError("x is undefined") })
    // A failed image load has no error object.
    listeners.get("error")!({})
    listeners.get("unhandledrejection")!({ reason: Object.assign(new Error("aborted"), { name: "AbortError" }) })
    for (let index = 0; index < 20; index++) listeners.get("unhandledrejection")!({ reason: `failure ${index}` })
    expect(fetch).toHaveBeenCalledTimes(10)
    const [url, init] = fetch.mock.calls[0]!
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

  it("reports a Vue error once when Nuxt also shows it as a NuxtError", () => {
    const { hooks, fetch, bodies } = runNuxtPlugin()
    const error = new TypeError("x is undefined")
    hooks.get("vue:error")!(error)
    hooks.get("app:error")!(Object.assign(new Error("x is undefined", { cause: error }), { name: "NuxtError" }))
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![0]).toBe("/shop/_vitehub/browser-errors")
    expect(bodies()[0]).toMatchObject({ kind: "vue", name: "TypeError" })
  })

  it("reports a chunk that fails to load", () => {
    const { listeners, bodies } = runReporter()
    listeners.get("vite:preloadError")!({ payload: new TypeError("Failed to fetch dynamically imported module: /assets/Cart.js") })
    expect(bodies()).toMatchObject([{ kind: "chunk", message: "Failed to fetch dynamically imported module: /assets/Cart.js" }])
    const nuxt = runNuxtPlugin()
    nuxt.hooks.get("app:chunkError")!({ error: new Error("Unable to preload CSS for /assets/Cart.css") })
    expect(nuxt.bodies()).toMatchObject([{ kind: "chunk", message: "Unable to preload CSS for /assets/Cart.css" }])
  })

  it.each(["error loading dynamically imported module: /assets/Cart.js", "Importing a module script failed."])("reports a module load failure (%s) as a chunk", (message) => {
    const { listeners, bodies } = runReporter()
    listeners.get("vite:preloadError")!({ payload: new TypeError(message) })
    expect(bodies()).toMatchObject([{ kind: "chunk", message }])
  })

  it("reports a missing chunk once per tab, not again on each reload", () => {
    const storage = tabStorage()
    const missing = () => new TypeError("Failed to fetch dynamically imported module: /assets/Cart.js")
    const first = runReporter("/orders", storage)
    first.listeners.get("vite:preloadError")!({ payload: missing() })
    const reload = runReporter("/orders", storage)
    reload.listeners.get("vite:preloadError")!({ payload: missing() })
    reload.listeners.get("vite:preloadError")!({ payload: new TypeError("Failed to fetch dynamically imported module: /assets/Checkout.js") })
    expect(first.fetch).toHaveBeenCalledOnce()
    expect(reload.bodies()).toMatchObject([{ kind: "chunk", message: "Failed to fetch dynamically imported module: /assets/Checkout.js" }])
  })

  it("reports lazy module execution errors on every page load, through Vite and Nuxt", async () => {
    const viteStorage = tabStorage()
    const nuxtStorage = tabStorage()
    for (let page = 0; page < 2; page++) {
      const vite = runReporter("/orders", viteStorage)
      const nuxt = runNuxtPlugin(nuxtStorage)
      const error = await import("./fixtures/browser-error-lazy-module.ts").catch((error: unknown) => error)
      vite.listeners.get("vite:preloadError")!({ payload: error })
      vite.listeners.get("unhandledrejection")!({ reason: error })
      nuxt.hooks.get("app:chunkError")!({ error })
      nuxt.hooks.get("app:error")!(error)
      for (const reporter of [vite, nuxt]) {
        expect(reporter.bodies()).toMatchObject([{ kind: "error", message: "Could not initialize the cart" }])
      }
    }
  })

  it("suppresses a deduped chunk's rethrow without spending a page slot", () => {
    const storage = tabStorage()
    const first = runReporter("/orders", storage)
    const message = "Failed to fetch dynamically imported module: /assets/Cart.js"
    first.listeners.get("vite:preloadError")!({ payload: new TypeError(message) })
    const reload = runReporter("/orders", storage)
    const error = new TypeError(message)
    reload.listeners.get("vite:preloadError")!({ payload: error })
    reload.listeners.get("unhandledrejection")!({ reason: error })
    expect(reload.fetch).not.toHaveBeenCalled()
    for (let index = 0; index < 11; index++) reportBrowserError(`failure ${index}`)
    expect(reload.bodies().map(body => body.message)).toEqual(Array.from({ length: 10 }, (_, index) => `failure ${index}`))
  })

  it("still reports a missing chunk when session storage throws", () => {
    const blocked = { getItem: () => { throw new DOMException("denied", "SecurityError") }, setItem: () => { throw new DOMException("denied", "SecurityError") } }
    const { listeners, fetch } = runReporter("/orders", blocked)
    listeners.get("vite:preloadError")!({ payload: new TypeError("Failed to fetch dynamically imported module: /assets/Cart.js") })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe("reportBrowserError", () => {
  it("does nothing when browserErrors is off or on the server", () => {
    expect(() => reportBrowserError(new Error("Could not save"))).not.toThrow()
  })

  it("sends a caught error with its action and fields", () => {
    const { fetch, bodies } = runReporter()
    reportBrowserError(new TypeError("Failed to fetch"), { action: "save-order", fields: { status: 503, orderId: "ord_7" } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", keepalive: true })
    expect(bodies()[0]).toEqual({
      kind: "handled",
      path: "/orders",
      name: "TypeError",
      message: "Failed to fetch",
      stack: expect.stringContaining("TypeError: Failed to fetch"),
      action: "save-order",
      fields: { status: 503, orderId: "ord_7" },
    })
  })

  it("sends a warning without a stack when it gets a message", () => {
    const { bodies } = runReporter()
    reportBrowserError("Sync is slow", { level: "warn", action: "sync" })
    expect(bodies()).toEqual([{ kind: "handled", path: "/orders", name: "Error", message: "Sync is slow", action: "sync", level: "warn" }])
  })

  it("shares the 10 reports and the once per message rule with the uncaught errors", () => {
    const { listeners, fetch } = runReporter()
    listeners.get("error")!({ error: new TypeError("x is undefined") })
    reportBrowserError(new TypeError("Failed to fetch"), { action: "save-order" })
    reportBrowserError(new TypeError("Failed to fetch"), { action: "save-order" })
    reportBrowserError(new TypeError("Failed to fetch"), { action: "load-cart" })
    expect(fetch).toHaveBeenCalledTimes(3)
    for (let index = 0; index < 20; index++) reportBrowserError(new Error(`failure ${index}`))
    expect(fetch).toHaveBeenCalledTimes(10)
  })

  it("drops fields the server would refuse before sending, and counts them", () => {
    const { bodies } = runReporter()
    const fields = { status: 503, note: "n".repeat(500), order: { id: 1 }, "bad key": 1, ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, index])) }
    Reflect.apply(reportBrowserError, undefined, [new Error("Could not save"), { action: "save-order", fields }])
    const [body] = bodies()
    expect(body!.fields).toEqual({ status: 503, note: "n".repeat(300), ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`field${index}`, index])) })
    expect(body!.droppedFields).toBe(4)
    expect(parseBrowserErrorReport(body)).toMatchObject({ fields: body!.fields, droppedFields: 4 })
  })

  it.each(["日", "\u0000"])("keeps a report with large serialized fields (%j) within the ingest limit", async (character) => {
    const { fetch, bodies } = runReporter()
    const fields = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, character.repeat(300)]))
    reportBrowserError("Checkout failed", { action: "checkout", fields })
    const error = vi.fn()
    const response = await createBrowserErrorsHandler().fetch(post(fetch.mock.calls[0]![1].body, undefined, { error }))
    expect(response.status).toBe(204)
    const { fields: kept, droppedFields } = bodies()[0]!
    expect(kept).toMatchObject({ field0: fields.field0 })
    expect(droppedFields).toBe(20 - Object.keys(kept as object).length)
    expect(droppedFields).toBeGreaterThan(0)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Checkout failed" }), {
      browserError: { kind: "handled", path: "/orders", level: "error", action: "checkout", fields: kept, droppedFields },
    })
  })

  it("keeps the message and fields when the encoded stack alone exceeds the ingest limit", async () => {
    const { fetch, bodies } = runReporter()
    const failure = Object.assign(new Error("Checkout failed"), { stack: "\u0000".repeat(4000) })
    reportBrowserError(failure, { fields: { status: 503 } })
    const error = vi.fn()
    expect((await createBrowserErrorsHandler().fetch(post(fetch.mock.calls[0]![1].body, undefined, { error }))).status).toBe(204)
    expect(bodies()[0]).not.toHaveProperty("stack")
    expect(bodies()[0]).toMatchObject({ message: "Checkout failed", fields: { status: 503 } })
  })

  it("skips an aborted request and never throws", () => {
    const { fetch } = runReporter()
    fetch.mockImplementation(() => {
      throw new Error("offline")
    })
    reportBrowserError(new DOMException("The user aborted a request.", "AbortError"))
    expect(fetch).not.toHaveBeenCalled()
    expect(() => reportBrowserError(new Error("Could not save"))).not.toThrow()
  })
})
