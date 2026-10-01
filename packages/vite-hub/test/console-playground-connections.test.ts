import { Readable } from "node:stream"
import type { IncomingMessage, ServerResponse } from "node:http"
import { afterEach, expect, it, vi } from "vitest"
import type { Plugin } from "vite"
import { connectionApprovalsSchema, connectionApprovalCountsSchema, connectionApprovalResultSchema, requestConnectionsManagement } from "../src/console/runtime/client/connections-management.ts"

afterEach(() => { vi.unstubAllGlobals() })

it.each(["approve", "deny"])("runs playground Connections refresh and %s through the real client", async action => {
  vi.resetModules()
  const { consoleMockAPI } = await vi.importActual<{ consoleMockAPI: () => Plugin }>("../../../playground/console/mock-api.ts")
  type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>
  let handler: Middleware | undefined
  const responses: string[] = []
  const plugin = consoleMockAPI()
  // SAFETY: The playground hook only registers its middleware with this server fixture.
  const configure = plugin.configureServer as (server: { middlewares: { use: (middleware: Middleware) => void } }) => void
  configure({ middlewares: { use: middleware => { handler = middleware } } })
  vi.stubGlobal("fetch", vi.fn(async (endpoint: string, init: RequestInit) => {
    // SAFETY: The mock route consumes only method, URL, and the request body stream.
    const request = Readable.from([String(init.body)]) as IncomingMessage
    request.method = "POST"
    request.url = endpoint
    let text = ""
    const output = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { text = value } }
    if (!handler) throw new Error("Expected playground middleware")
    // SAFETY: The mock route writes only statusCode, headers, and the response body.
    await handler(request, output as unknown as ServerResponse, () => { throw new Error("Unexpected next middleware") })
    responses.push(text)
    return new Response(text, { status: output.statusCode, headers: { "content-type": "application/json" } })
  }))
  const endpoint = "/_vitehub/connections"
  const counts = await requestConnectionsManagement(endpoint, "approval-counts", connectionApprovalCountsSchema)
  expect(counts.counts.gmail).toBe(1)
  const page = await requestConnectionsManagement(endpoint, "approval-summaries", connectionApprovalsSchema, { name: "gmail", status: "pending" })
  expect(page.approvals).toHaveLength(1)
  expect(page.approvals[0]).not.toHaveProperty("input")
  const decision = await requestConnectionsManagement(endpoint, `${action}-summary`, connectionApprovalResultSchema, { id: page.approvals[0]!.id })
  expect(decision.approval.status).toBe(action === "approve" ? "executed" : "denied")
  expect(decision.approval).not.toHaveProperty("input")
  expect(decision).not.toHaveProperty("result")
  expect((await requestConnectionsManagement(endpoint, "approval-counts", connectionApprovalCountsSchema)).counts.gmail).toBe(0)
  expect(responses.join("\n")).not.toContain('"input"')
  expect(responses.join("\n")).not.toContain("msg_synthetic")
  const raw = await fetch(endpoint, { method: "POST", body: JSON.stringify({ action: "approvals", name: "gmail" }) })
  expect(await raw.json()).toMatchObject({ approvals: expect.arrayContaining([expect.objectContaining({ input: { to: "team@example.com" } })]) })
})
