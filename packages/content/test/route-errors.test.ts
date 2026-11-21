import { expect, it } from "vitest"

import { contentRouteLogger, withContentRouteErrors } from "../src/route-errors.ts"

it("forwards prototype logger methods with their original receiver and keeps route diagnostics", async () => {
  class CustomLogger {
    calls: Array<[string, string, ...unknown[]]> = []
    debug(tag: string, ...args: unknown[]) { this.calls.push(["debug", tag, ...args]) }
    info(tag: string, ...args: unknown[]) { this.calls.push(["info", tag, ...args]) }
    warn(tag: string, ...args: unknown[]) { this.calls.push(["warn", tag, ...args]) }
    error(tag: string, ...args: unknown[]) { this.calls.push(["error", tag, ...args]) }
  }
  const base = new CustomLogger()
  const logger = contentRouteLogger(base)
  const error = Object.assign(new Error("Read failed"), { code: "WORKSPACE_R0072", fix: "Set the token" })
  const response = await withContentRouteErrors(async () => {
    logger.debug("read", "start")
    logger.info("read", "loading")
    logger.warn("read", "duplicate path")
    logger.error("api", "failed", error)
    return Response.json({ error: "internal_error" }, { status: 500 })
  })
  expect(base.calls).toEqual([
    ["debug", "read", "start"],
    ["info", "read", "loading"],
    ["warn", "read", "duplicate path"],
    ["error", "api", "failed", error],
  ])
  expect(await response.json()).toMatchObject({ code: error.code, fix: error.fix, message: error.message })
})
