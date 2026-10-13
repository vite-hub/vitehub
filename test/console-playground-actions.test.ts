import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"

import { consoleMockAPI } from "../playground/console/mock-api.ts"

async function invoke(body: string, id = "missing", method: "GET" | "POST" = "POST"): Promise<{ body: unknown, status: number }> {
  let middleware: ((request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>) | undefined
  // SAFETY: The local plugin defines configureServer as a callable hook.
  const configureServer = consoleMockAPI().configureServer as (server: { middlewares: { use: (handler: NonNullable<typeof middleware>) => void } }) => void
  // SAFETY: The hook reads only the middleware registration boundary in this test.
  configureServer({ middlewares: { use: (handler) => { middleware = handler } } })
  const request = Object.assign(Readable.from([body]), { method, url: `/api/_vitehub/console/invocations/${id}` })
  let value: unknown
  const response = {
    statusCode: 200,
    setHeader() {},
    end(body: string) { value = JSON.parse(body) },
  }
  // SAFETY: The middleware consumes a request stream and the three response methods supplied above.
  await middleware!(request as IncomingMessage, response as unknown as ServerResponse, () => { throw new Error("Unexpected next") })
  return { body: value, status: response.statusCode }
}

describe("Console playground Invocation actions", () => {
  it.each(["{", '{"action":"rerun"}', '{"action":"cancel","extra":true}', "[]", "null", "{}"])("rejects unsupported input %s before cancellation", async (body) => {
    expect(await invoke(body, "ainv_capabilities_mcp_title")).toMatchObject({ status: 400 })
    expect(await invoke("", "ainv_capabilities_mcp_title", "GET")).toMatchObject({ status: 200 })
  })

  it("accepts the strict cancel action and reports a missing record", async () => {
    expect(await invoke('{"action":"cancel"}')).toMatchObject({ status: 404, body: { error: "Invocation not found" } })
  })

  it("rejects cancellation for a terminal record", async () => {
    expect(await invoke('{"action":"cancel"}', "ainv_capabilities_mcp_title")).toEqual({
      status: 409,
      body: { error: "Only pending or running invocations can be cancelled." },
    })
    expect(await invoke("", "ainv_capabilities_mcp_title", "GET")).toMatchObject({ status: 200 })
  })

  it.each(["ainv_queue_visibility", "ainv_console_navigation"])("cancels %s while it is active", async (id) => {
    expect(await invoke('{"action":"cancel"}', id)).toMatchObject({ status: 200 })
    expect(await invoke("", id, "GET")).toMatchObject({ status: 200 })
  })
})
