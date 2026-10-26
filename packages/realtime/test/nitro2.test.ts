import { afterEach, describe, expect, it, vi } from "vitest"

import type { RealtimeDefinition } from "../src/types.ts"
import { createRealtimeHandler, registerRealtimeDurableObject } from "../src/server.ts"
import { FakeSql, createMemoryAdapter, createStubEditor, registryOf } from "./harness.ts"

import type { WebSocketHooks, WebSocketPeer } from "h3"

const roomUrl = "https://example.com/api/_vitehub/realtime/docs/posts/hello"

function definition(extra: Partial<RealtimeDefinition> = {}): RealtimeDefinition {
  return { document: createMemoryAdapter({ "posts/hello": { body: "Hello" } }).adapter, editor: createStubEditor().editor, ...extra }
}

/** The hooks that Nitro 2 reads from a handler, and a crossws upgrade request with its read-only context. */
function nitro2(extra: Partial<RealtimeDefinition> = {}, context = {}) {
  const handler = createRealtimeHandler(registryOf(definition(extra)) as never)
  // SAFETY: the handler sets `__websocket__` to crossws hooks for Nitro 2.
  const hooks = Reflect.get(handler, "__websocket__") as Required<Pick<WebSocketHooks, "close" | "message" | "open" | "upgrade">>
  const request = Object.defineProperty(new Request(roomUrl, { headers: { upgrade: "websocket" } }), "context", { enumerable: true, value: context })
  const sent: Uint8Array[] = []
  const close = vi.fn()
  // SAFETY: the room uses only these peer members.
  const peer = { close, context: {}, publish() {}, request, send: (data: Uint8Array) => sent.push(data), subscribe() {}, unsubscribe() {} } as unknown as WebSocketPeer
  return { close, handler, hooks, peer, request, sent }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.realtime.durable-object"))
})

describe("Nuxt 4 and Nitro 2", () => {
  it.each([false, true])("preserves upgrade context for identity and authorization (Durable Object: %s)", async (durable) => {
    const context = { sentinel: "session", _platform: { sentinel: "platform", cloudflare: { sentinel: "cloudflare" } } }
    const state = { storage: { sql: new FakeSql().carrier } }
    const env = { sentinel: "env" }
    if (durable) registerRealtimeDurableObject(state, env)
    const expected = durable
      ? { ...context, _platform: { ...context._platform, cloudflare: { ...context._platform.cloudflare, context: state, env } } }
      : context
    const identify = vi.fn(({ event }: Parameters<NonNullable<RealtimeDefinition["identify"]>>[0]) => {
      expect(event.context).toMatchObject(expected)
      return { id: "ana" }
    })
    const authorize = vi.fn(({ event }: Parameters<NonNullable<RealtimeDefinition["authorize"]>>[0]) => {
      expect(event.context).toMatchObject(expected)
      return true
    })
    const { hooks, request } = nitro2({ identify, authorize }, context)

    await expect(hooks.upgrade(request)).resolves.toBeUndefined()

    expect(identify).toHaveBeenCalledOnce()
    expect(authorize).toHaveReturnedTimes(2)
    expect(context).toEqual({ sentinel: "session", _platform: { sentinel: "platform", cloudflare: { sentinel: "cloudflare" } } })
  })

  it("forwards a WebSocket upgrade from an H3 1 event, which carries Node's request, to the Durable Object", async () => {
    const fetch = vi.fn(async (request: Request) => new Response(`${request.method} ${request.url} ${request.headers.get("upgrade")}`))
    const handler = createRealtimeHandler(registryOf(definition()) as never)
    const event = {
      context: { _platform: { cloudflare: { env: { $DurableObject: { get: () => ({ fetch }), idFromName: (name: string) => ({ name }) } } } } },
      node: { req: { headers: { connection: "Upgrade", host: "example.com", upgrade: "websocket" }, method: "GET", url: "/api/_vitehub/realtime/docs/posts%2Fhello", async* [Symbol.asyncIterator]() {} } },
    }

    const response = await handler(event)

    expect(response).toBeInstanceOf(Response)
    await expect((response as Response).text()).resolves.toBe("GET http://example.com/api/_vitehub/realtime/docs/posts%2Fhello websocket")
  })

  it("opens a socket that Nitro 2 upgrades, and joins the room of its request", async () => {
    const { close, hooks, peer, request, sent } = nitro2()

    await expect(hooks.upgrade(request)).resolves.toBeUndefined()
    await hooks.open(peer)

    // The session control and the first sync step.
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(close).not.toHaveBeenCalled()
  })

  it("keeps the status of a refused upgrade", async () => {
    const { hooks, request } = nitro2({ auth: true })

    const refusal = await hooks.upgrade(request)

    expect(refusal).toBeInstanceOf(Response)
    expect((refusal as Response).status).toBe(403)
  })

  it("opens the room in the Durable Object's storage instead of forwarding to itself", async () => {
    const fetch = vi.fn(async () => new Response("forwarded"))
    const sql = new FakeSql()
    registerRealtimeDurableObject({ storage: { sql: sql.carrier } }, { $DurableObject: { get: () => ({ fetch }), idFromName: (name: string) => ({ name }) } })
    const { hooks, peer, request, sent } = nitro2()

    await expect(hooks.upgrade(request)).resolves.toBeUndefined()
    await hooks.open(peer)

    expect(fetch).not.toHaveBeenCalled()
    expect(sent.length).toBeGreaterThanOrEqual(2)
  })

  it("closes a socket whose room this isolate no longer holds, so the client reconnects", async () => {
    const { close, hooks, peer } = nitro2()

    await hooks.message(peer, { uint8Array: () => new Uint8Array([0]) } as never)

    expect(close).toHaveBeenCalledWith(1012, "The realtime room restarted.")
  })
})
