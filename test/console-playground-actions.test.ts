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
  it.each(["{", '{"action":"cancel"}', '{"action":"delete","extra":true}', "[]", "null", "{}"])("rejects unsupported input %s before deletion", async (body) => {
    expect(await invoke(body, "ainv_capabilities_mcp_title")).toMatchObject({ status: 400 })
    expect(await invoke("", "ainv_capabilities_mcp_title", "GET")).toMatchObject({ status: 200 })
  })

  it("accepts the strict delete action and reports a missing record", async () => {
    expect(await invoke('{"action":"delete"}')).toMatchObject({ status: 404, body: { error: "Invocation not found" } })
  })

  it("deletes an existing record only after the strict delete action", async () => {
    expect(await invoke('{"action":"delete"}', "ainv_capabilities_mcp_title")).toEqual({
      status: 200,
      body: { id: "ainv_capabilities_mcp_title", outcome: "deleted" },
    })
    expect(await invoke("", "ainv_capabilities_mcp_title", "GET")).toMatchObject({ status: 404 })
  })

  it.each(["ainv_queue_visibility", "ainv_console_navigation"])("keeps %s while it is not terminal", async (id) => {
    expect(await invoke('{"action":"delete"}', id)).toEqual({
      status: 409,
      body: { error: "Only completed, failed, or cancelled invocations can be deleted." },
    })
    expect(await invoke("", id, "GET")).toMatchObject({ status: 200 })
  })
})
