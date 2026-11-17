import { AsyncLocalStorage } from "node:async_hooks"

import type { Logger } from "comark-content"

/**
 * Comark Content's handler answers every thrown error with 500 `internal_error` and only its message, so a coded
 * ViteHub error, such as a GitHub Workspace store without a token, loses its code and fix. Comark still logs the error
 * with the `api` tag, so the logger keeps it for the request that is running.
 */
const routeFailures = new AsyncLocalStorage<{ error?: Error }>()

function consoleLogger(): Logger {
  const print = (method: "debug" | "info" | "warn" | "error") => (tag: string, ...args: unknown[]) => console[method](`[comark-content@${tag}]`, ...args)
  return { debug: print("debug"), info: print("info"), warn: print("warn"), error: print("error") }
}

/** The logger of the Content hubs: the configured one (`false` prints nothing), which also keeps the failure of a route. */
export function contentRouteLogger(logger: Logger | false | undefined): Logger {
  const base: Logger = logger === false ? { debug() {}, info() {}, warn() {}, error() {} } : logger ?? consoleLogger()
  return {
    debug(tag, ...args) { base.debug(tag, ...args) },
    info(tag, ...args) { base.info(tag, ...args) },
    warn(tag, ...args) { base.warn(tag, ...args) },
    error(tag, ...args) {
      const failure = routeFailures.getStore()
      const error = args.findLast(arg => arg instanceof Error)
      if (failure && tag === "api" && error) failure.error = error
      base.error(tag, ...args)
    },
  }
}

function stringField(error: Error, key: string): string | undefined {
  const value: unknown = Reflect.get(error, key)
  return typeof value === "string" && value ? value : undefined
}

function failureResponse(error: Error, headers: Headers): Response | undefined {
  const code = stringField(error, "code")
  if (!code) return
  const fix = stringField(error, "fix")
  const docs = stringField(error, "docs")
  return Response.json(
    { error: "internal_error", code, message: error.message, ...(fix ? { fix } : {}), ...(docs ? { docs } : {}) },
    { status: 500, headers },
  )
}

/** Serve a Content route, and give a coded error its code, fix, and docs link in the 500 answer. */
export async function withContentRouteErrors(dispatch: () => Promise<Response>): Promise<Response> {
  const failure: { error?: Error } = {}
  const response = await routeFailures.run(failure, dispatch)
  if (response.status !== 500 || !failure.error) return response
  return failureResponse(failure.error, response.headers) ?? response
}
