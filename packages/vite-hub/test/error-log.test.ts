import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { defineErrors, isRuntimeDiagnostic, isViteHubError, normalizeRuntimeDiagnosticError, toResponse, ViteHubError } from "@vite-hub/runtime"
import evlog from "evlog/nitro/v3"
import { build, createNitro } from "nitro/builder"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { errorLogVitePlugin, renderErrorLogNitroHandler, renderErrorLogNitroPlugin, renderResultErrorNitroHandler, resultErrorVitePlugin } from "../src/error-log-vite.ts"

type ErrorHook = (error: unknown, context?: { event?: { req: { url: string, method: string } }, tags?: string[] }) => void

/** Evaluates the generated plugin with the runtime normalizer and returns its `error` hook. */
function errorHook(h3?: { config: { silent?: boolean } }): ErrorHook {
  const source = renderErrorLogNitroPlugin()
    .replace(`import { normalizeRuntimeDiagnosticError } from "vite-hub/runtime"`, "")
    .replace("export default function", "return function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  const plugin = new Function("normalizeRuntimeDiagnosticError", source)(normalizeRuntimeDiagnosticError) as (app: unknown) => void
  let hook: ErrorHook | undefined
  plugin({ h3, hooks: { hook: (name: string, handler: ErrorHook) => { if (name === "error") hook = handler } } })
  if (!hook) throw new Error("The plugin did not register an error hook.")
  return hook
}

/** An unhandled error as h3 passes it to Nitro: an HTTPError wrapper whose cause is the thrown error. */
function unhandled(thrown: Error) {
  return Object.assign(new Error("HTTPError", { cause: thrown }), {
    status: 502,
    unhandled: true,
    toJSON: () => ({ message: "HTTPError", status: 502, unhandled: true }),
  })
}

afterEach(() => vi.restoreAllMocks())

describe("generated error log Nitro plugin", () => {
  it("logs the thrown error of an unhandled request error with its stack, status, and cause chain", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const gmail = Object.assign(new Error("Gmail token refresh failed"), { status: 502 })
    const thrown = new Error("sync failed", { cause: gmail })

    errorHook()(unhandled(thrown), { event: { req: new Request("https://app.test/api/sync?x=1", { method: "POST" }) } })

    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toBe("[vitehub] Unhandled error in POST /api/sync")
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      message: "sync failed",
      stack: expect.stringContaining("sync failed"),
      cause: { message: "Gmail token refresh failed", status: 502 },
    })
  })

  it("logs requests with a relative URL", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const thrown = new Error("request failed")
    errorHook()(unhandled(thrown), { event: { req: { url: "/api/post?draft=true", method: "GET" } } })
    expect(log.mock.calls[0]?.[0]).toBe("[vitehub] Unhandled error in GET /api/post")
    expect(log.mock.calls[0]?.[1]).toMatchObject({ message: "request failed" })
  })

  it("does not log errors that a route throws on purpose", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    errorHook()(Object.assign(new Error("Unauthorized"), { status: 401 }), { event: { req: new Request("https://app.test/api/sync") } })
    expect(log).not.toHaveBeenCalled()
  })

  it("turns off the h3 log of the same error", () => {
    const h3 = { config: { silent: false } }
    errorHook(h3)
    expect(h3.config.silent).toBe(true)
  })

  it("answers with Nitro's default response and asks it not to log the error again", async () => {
    const source = renderErrorLogNitroHandler().replace("export default async function", "return async function")
    // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
    const handler = new Function(source)() as (error: unknown, event: unknown, options: { defaultHandler: typeof defaultHandler }) => Promise<Response>
    const defaultHandler = vi.fn(async (_error: unknown, _event: unknown, _options: { silent: boolean }) => ({
      body: { error: true, status: 500, unhandled: true },
      headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
      status: 500,
      statusText: "",
    }))
    const error = unhandled(new Error("sync failed"))
    const response = await handler(error, {}, { defaultHandler })
    expect(defaultHandler).toHaveBeenCalledWith(error, {}, { silent: true })
    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({ error: true, status: 500, unhandled: true })
  })

  it("writes the logging plugin and defers installing its error handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-error-log-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const plugin = errorLogVitePlugin()
    const config: { root: string, nitro: Record<string, unknown> } = { root, nitro: { errorHandler: "./server/error.ts" } }
    if (typeof plugin.config !== "function") throw new TypeError("Expected a config hook.")
    await plugin.config.call({} as never, config, { command: "serve", mode: "development" })
    const handler = join(root, ".vitehub/nitro/error-log-handler.mjs")
    expect(config.nitro.errorHandler).toBe("./server/error.ts")
    expect(config.nitro.plugins).toEqual([join(root, ".vitehub/nitro/error-log.mjs")])
    expect(await readFile(handler, "utf8")).toBe(renderErrorLogNitroHandler())
  })

  it("names the Nitro phase for errors outside a request", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    errorHook()(new Error("plugin failed"), { tags: ["plugin"] })
    expect(log.mock.calls[0]?.[0]).toBe("[vitehub] Unhandled error in plugin")
    expect(log.mock.calls[0]?.[1]).toMatchObject({ message: "plugin failed" })
  })
})

type ResultErrorHandler = (error: unknown, event: { req: Request }) => Promise<Response | undefined>

function resultErrorHandler(dev: boolean): ResultErrorHandler {
  const source = renderResultErrorNitroHandler()
    .replace(`import { isRuntimeDiagnostic, isViteHubError, toResponse } from "vite-hub/runtime"`, "")
    .replace("import.meta.dev", "dev")
    .replace("export default async function", "return async function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("isRuntimeDiagnostic", "isViteHubError", "toResponse", "dev", source)(isRuntimeDiagnostic, isViteHubError, toResponse, dev) as ResultErrorHandler
}

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/example",
  codes: {
    EXAMPLE_CONFLICT: { why: "Someone else saved first.", fix: "Read the record again, then save.", status: 409 },
    EXAMPLE_FAILED: { why: "The provider failed.", fix: "Try again." },
  },
})

const json = (url = "https://app.test/api/save") => ({ req: new Request(url, { headers: { accept: "application/json" } }) })

describe("generated result error Nitro handler", () => {
  it("answers a thrown ResultError with its status, code, why, and fix in development", async () => {
    const response = await resultErrorHandler(true)(unhandled(errors.EXAMPLE_CONFLICT({ cause: new Error("secret provider detail") })), json())
    expect(response?.status).toBe(409)
    expect(response?.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response?.json()).toEqual({ code: "EXAMPLE_CONFLICT", why: "Someone else saved first.", fix: "Read the record again, then save." })
  })

  it("answers only the code in production", async () => {
    const response = await resultErrorHandler(false)(unhandled(errors.EXAMPLE_CONFLICT()), json())
    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({ code: "EXAMPLE_CONFLICT" })
  })

  it("answers 500 when the code has no status", async () => {
    const response = await resultErrorHandler(false)(unhandled(errors.EXAMPLE_FAILED()), json())
    expect(response?.status).toBe(500)
    expect(await response?.json()).toEqual({ code: "EXAMPLE_FAILED" })
  })

  it("answers a ViteHubError with its code", async () => {
    const response = await resultErrorHandler(false)(unhandled(new ViteHubError("EXAMPLE_BROKEN", "Broken.")), json())
    expect(response?.status).toBe(500)
    expect(await response?.json()).toEqual({ code: "EXAMPLE_BROKEN" })
  })

  it("leaves other errors and HTML requests to the next handler", async () => {
    const handler = resultErrorHandler(true)
    expect(await handler(unhandled(new Error("secret db password")), json())).toBeUndefined()
    expect(await handler(Object.assign(new Error("Unauthorized"), { status: 401 }), json())).toBeUndefined()
    const page = { req: new Request("https://app.test/save", { headers: { accept: "text/html,application/xhtml+xml" } }) }
    expect(await handler(unhandled(errors.EXAMPLE_CONFLICT()), page)).toBeUndefined()
  })

  it.each([
    { dev: true, observability: false, inline: false },
    { dev: false, observability: true, inline: false },
    { dev: false, observability: false, inline: true },
  ])("preserves custom handlers and error headers in Nitro dispatch (%j)", async ({ dev, observability, inline }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-result-error-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    await writeFile(join(root, "entry.mjs"), `import { useNitroApp } from "nitro/app"; export const fetch = useNitroApp().fetch`)
    await writeFile(join(root, "error.mjs"), `export default () => new Response("custom error page", { status: 503 })`)
    if (!inline) await writeFile(join(root, "nitro.config.mjs"), `export default { errorHandler: "./error.mjs" }`)
    await writeFile(join(root, "route.mjs"), `
      import { defineErrors } from "vite-hub/runtime"
      import { installStandardContext } from "@vite-hub/runtime/internal/h3"
      const errors = defineErrors({ docs: "https://example.test", codes: {
        EXAMPLE_CONFLICT: { why: "Conflict.", fix: "Retry.", status: 409 },
      } })
      export default event => {
        if (event.url.pathname === "/boom") throw new Error("ordinary error")
        installStandardContext(event)
        const headers = event["~standard"].res.headers
        headers.set("cache-control", "private, no-store")
        headers.set("content-type", "text/plain")
        headers.append("set-cookie", "first=; Max-Age=0")
        headers.append("set-cookie", "second=; Max-Age=0")
        throw errors.EXAMPLE_CONFLICT()
      }
    `)
    const config: { root: string, nitro: Record<string, unknown> } = { root, nitro: {} }
    const plugins = observability ? [resultErrorVitePlugin()] : [errorLogVitePlugin(), resultErrorVitePlugin()]
    for (const plugin of plugins) {
      if (typeof plugin.config !== "function") throw new TypeError("Expected a config hook.")
      await plugin.config.call({} as never, config, { command: dev ? "serve" : "build", mode: dev ? "development" : "production" })
    }
    const nitro = await createNitro({
      ...config.nitro,
      ...inline && { errorHandler: "./error.mjs" },
      rootDir: root,
      dev,
      preset: "node-middleware",
      entry: join(root, "entry.mjs"),
      logLevel: 0,
      alias: {
        "vite-hub/runtime": fileURLToPath(import.meta.resolve("@vite-hub/runtime")),
        "@vite-hub/runtime/internal/h3": fileURLToPath(import.meta.resolve("@vite-hub/runtime/internal/h3")),
      },
      handlers: [{ route: "/**", handler: join(root, "route.mjs") }],
      ...(observability && { modules: [...Array.isArray(config.nitro.modules) ? config.nitro.modules : [], evlog({ pretty: false })] }),
    })
    onTestFinished(() => nitro.close())
    if (dev) {
      const compiled = new Promise<void>((resolve, reject) => {
        nitro.hooks.hookOnce("compiled", () => resolve())
        nitro.hooks.hookOnce("dev:error", reject)
      })
      await Promise.all([build(nitro), compiled])
      await nitro.close()
    }
    else await build(nitro)
    const app: { fetch(request: Request): Promise<Response> } = await import(pathToFileURL(join(nitro.options.output.serverDir, "index.mjs")).href)
    const response = await app.fetch(json("https://app.test/api/conflict").req)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(dev ? { code: "EXAMPLE_CONFLICT", why: "Conflict.", fix: "Retry." } : { code: "EXAMPLE_CONFLICT" })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.getSetCookie()).toEqual(["first=; Max-Age=0", "second=; Max-Age=0"])

    for (const route of ["/boom", "/conflict"]) {
      const page = await app.fetch(new Request(`https://app.test${route}`, { headers: { accept: "text/html" } }))
      expect(page.status).toBe(503)
      expect(await page.text()).toBe("custom error page")
    }
  }, 30_000)
})
