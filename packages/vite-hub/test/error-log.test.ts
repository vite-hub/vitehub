import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { renderErrorLogNitroPlugin } from "../src/error-log-vite.ts"

type ErrorHook = (error: unknown, context?: { event?: { req: Request }, tags?: string[] }) => void

/** Evaluates the generated plugin with the runtime normalizer and returns its `error` hook. */
function errorHook(): ErrorHook {
  const source = renderErrorLogNitroPlugin()
    .replace(`import { normalizeRuntimeDiagnosticError } from "vite-hub/runtime"`, "")
    .replace("export default function", "return function")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  const plugin = new Function("normalizeRuntimeDiagnosticError", source)(normalizeRuntimeDiagnosticError) as (app: unknown) => void
  let hook: ErrorHook | undefined
  plugin({ hooks: { hook: (name: string, handler: ErrorHook) => { if (name === "error") hook = handler } } })
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

  it("does not log errors that a route throws on purpose", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    errorHook()(Object.assign(new Error("Unauthorized"), { status: 401 }), { event: { req: new Request("https://app.test/api/sync") } })
    expect(log).not.toHaveBeenCalled()
  })

  it("names the Nitro phase for errors outside a request", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    errorHook()(new Error("plugin failed"), { tags: ["plugin"] })
    expect(log.mock.calls[0]?.[0]).toBe("[vitehub] Unhandled error in plugin")
    expect(log.mock.calls[0]?.[1]).toMatchObject({ message: "plugin failed" })
  })
})
