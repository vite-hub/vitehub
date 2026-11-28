import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { errorLogVitePlugin, renderErrorLogNitroHandler, renderErrorLogNitroPlugin } from "../src/error-log-vite.ts"

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

  it("adds its error handler after the error handlers of the app", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-error-log-"))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    const plugin = errorLogVitePlugin()
    const config: { root: string, nitro: Record<string, unknown> } = { root, nitro: { errorHandler: "./server/error.ts" } }
    if (typeof plugin.config !== "function") throw new TypeError("Expected a config hook.")
    await plugin.config.call({} as never, config, { command: "serve", mode: "development" })
    const handler = join(root, ".vitehub/nitro/error-log-handler.mjs")
    expect(config.nitro.errorHandler).toEqual(["./server/error.ts", handler])
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
