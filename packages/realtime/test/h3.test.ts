import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

import { createRealtimeHandler } from "../src/server.ts"
import { createMemoryAdapter, createStubEditor, registryOf } from "./harness.ts"

function handler() {
  return createRealtimeHandler(registryOf({
    access: "public",
    document: createMemoryAdapter({ "posts/hello": { body: "Hello" } }).adapter,
    editor: createStubEditor().editor,
  }) as never)
}

describe("H3 2 request events", () => {
  it("forwards a WebSocket upgrade to the Durable Object", async () => {
    const fetch = vi.fn(async (request: Request) => new Response(`${request.method} ${request.url} ${request.headers.get("upgrade")}`))
    const req = new Request("http://example.com/api/_vitehub/realtime/docs/posts%2Fhello", { headers: { connection: "Upgrade", upgrade: "websocket" } })
    const event = new H3Event(req, {
      _platform: { cloudflare: { env: { $DurableObject: { get: () => ({ fetch }), idFromName: (name: string) => ({ name }) } } } },
    })

    const response = await handler()(event)

    expect(fetch).toHaveBeenCalledExactlyOnceWith(req)
    expect(response).toBeInstanceOf(Response)
    await expect((response as Response).text()).resolves.toBe("GET http://example.com/api/_vitehub/realtime/docs/posts%2Fhello websocket")
  })

  it("keeps host Standard Context so its bindings reach the Durable Object", async () => {
    const fetch = vi.fn(async (request: Request) => new Response(`${request.method} ${request.url}`))
    const req = new Request("http://example.com/api/_vitehub/realtime/docs/posts%2Fhello", { headers: { upgrade: "websocket" } })
    // The host set Standard Context with bindings that the event context does not hold.
    const standard = { vendor: "host", req, res: {}, runtime: { cloudflare: { env: { $DurableObject: { get: () => ({ fetch }), idFromName: (name: string) => ({ name }) } } } } }
    const event = new H3Event(req)
    Object.defineProperty(event, "~standard", { value: standard })

    const response = await handler()(event)

    expect(event["~standard"]).toBe(standard)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(req)
    await expect((response as Response).text()).resolves.toBe("GET http://example.com/api/_vitehub/realtime/docs/posts%2Fhello")
  })
})
