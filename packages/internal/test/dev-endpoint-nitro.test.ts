import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { Readable, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import {
  assertViteHubDevRequestGrant,
  findViteHubNitroDevEnvironment,
  forwardViteHubDevRequestToNitro,
  isViteHubNitroDevHostAllowed,
  registerViteHubNitroDevEndpoint,
  renderViteHubNitroDevHandler,
  validateViteHubDevRequest,
  validateViteHubNitroDevRequest,
  viteHubNitroDevUnavailableCode,
  viteHubNitroDevUnavailableMessage,
  viteHubNitroRuntimeRoute,
} from "../src/dev-endpoint.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteHubDevRequestGrant, ViteHubNitroDevServer } from "../src/dev-endpoint.ts"

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

const root = "/project"
const route = "/__test/dev"
const runtimeRoute = "/_vitehub/test/dev"
const guard = { header: "x-test-dev", headerValue: "1", label: "Test Dev" }
const guardHeaders = { [guard.header]: guard.headerValue }
const json = { ...guardHeaders, "content-type": "application/json" }

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: ViteHubNitroDevServer = {
    config: { root, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

function incoming(init: { body?: string, headers?: Record<string, string>, method: string }): IncomingMessage {
  return Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: route,
  }) as unknown as IncomingMessage
}

function grantFor(req: IncomingMessage): ViteHubDevRequestGrant {
  const { grant } = validateViteHubDevRequest({ config: { server: { port: 5173 } } }, req, guard)
  if (!grant) throw new Error("The test request does not pass the guard.")
  return grant
}

function guarded(init: { body?: string, headers?: Record<string, string>, method: string }): [IncomingMessage, ViteHubDevRequestGrant] {
  const req = incoming({ ...init, headers: { ...json, ...init.headers } })
  return [req, grantFor(req)]
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      done.emit("end")
      callback()
    },
  }), {
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
  })
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(incoming(init), res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

function nitroRequest(init: { headers?: Record<string, string>, method?: string } = {}): Request {
  return new Request(`http://localhost:5173${runtimeRoute}`, {
    body: init.method === "GET" ? undefined : "{}",
    headers: init.headers ?? json,
    method: init.method ?? "POST",
  })
}

describe("Nitro dev forwarding", () => {
  it("cancels a stalled buffered response without writing after disconnect", async () => {
    const reading = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const cancel = vi.fn(() => cancelled.resolve())
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
      },
      pull() {
        reading.resolve()
        return new Promise<void>(() => {})
      },
      cancel,
    }))
    const dispatchFetch = vi.fn(async (_request: Request) => response)
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })
    const req = incoming({ body: "{}", headers: json, method: "POST" })
    const res = Object.assign(new Writable(), { setHeader: vi.fn(), statusCode: 200 }) as unknown as ServerResponse
    const write = vi.spyOn(res, "write")
    const end = vi.spyOn(res, "end")
    middlewares[0]!(req, res, vi.fn())
    await reading.promise
    expect(response.body?.locked).toBe(true)
    res.destroy()
    await cancelled.promise
    await vi.waitFor(() => expect(response.body?.locked).toBe(false))
    expect(dispatchFetch.mock.calls[0]![0].signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })

  it("aborts Nitro work when the client disconnects before the response", async () => {
    const requestStarted = Promise.withResolvers<Request>()
    const dispatchFetch = vi.fn((request: Request) => {
      requestStarted.resolve(request)
      return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
    })
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute, streamResponse: true })
    const req = incoming({ body: "{}", headers: json, method: "POST" })
    const res = new Writable() as unknown as ServerResponse
    middlewares[0]!(req, res, vi.fn())
    const request = await requestStarted.promise
    res.destroy()
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }))
    expect(request.signal.aborted).toBe(true)
  })

  it("cancels a runtime response that arrives after the client disconnects", async () => {
    const requestStarted = Promise.withResolvers<void>()
    const runtimeResponse = Promise.withResolvers<Response>()
    const cancelled = Promise.withResolvers<void>()
    const cancel = vi.fn(() => cancelled.resolve())
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch: async () => {
      requestStarted.resolve()
      return runtimeResponse.promise
    } } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute, streamResponse: true })
    const req = incoming({ body: "{}", headers: json, method: "POST" })
    const res = new Writable() as unknown as ServerResponse
    middlewares[0]!(req, res, vi.fn())
    await requestStarted.promise
    res.destroy()
    runtimeResponse.resolve(new Response(new ReadableStream({ cancel })))
    await cancelled.promise
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("cancels a stalled runtime stream when the client disconnects", async () => {
    const firstChunk = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const cancel = vi.fn(() => cancelled.resolve())
    const pull = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
      },
      cancel,
      pull,
    }))
    const dispatchFetch = vi.fn(async (_request: Request) => response)
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute, streamResponse: true })
    const req = incoming({ body: "{}", headers: json, method: "POST" })
    const res = Object.assign(new Writable({
      write(_chunk, _encoding, callback) {
        firstChunk.resolve()
        callback()
      },
    }), { setHeader: vi.fn(), statusCode: 200 }) as unknown as ServerResponse
    middlewares[0]!(req, res, vi.fn())
    await firstChunk.promise
    expect(pull).toHaveBeenCalledOnce()
    expect(dispatchFetch.mock.calls[0]![0].signal.aborted).toBe(false)
    res.destroy()
    await cancelled.promise
    expect(cancel).toHaveBeenCalledOnce()
    expect(dispatchFetch.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it("forwards streamed bytes without buffering the response", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
        controller.enqueue(new TextEncoder().encode("second"))
        controller.close()
      },
    }))
    const buffered = vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("must stream"))
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch: async () => response } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute, streamResponse: true })
    const result = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(result).toMatchObject({ body: "firstsecond", status: 200 })
    expect(buffered).not.toHaveBeenCalled()
  })

  it("buffers all response chunks until the runtime body finishes", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
        controller.enqueue(new TextEncoder().encode("second"))
        controller.close()
      },
    }), { status: 201, headers: { "content-type": "text/plain" } })
    const { server, middlewares } = fakeServer({ nitro: { dispatchFetch: async () => response } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })
    const result = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(result).toMatchObject({ body: "firstsecond", headers: { "content-type": "text/plain" }, status: 201 })
  })

  it("adds trusted runtime headers without forwarding incoming credentials", async () => {
    const dispatchFetch = vi.fn(async (_request: Request) => new Response())
    await forwardViteHubDevRequestToNitro({ environments: { nitro: { dispatchFetch } } }, ...guarded({ body: "{}", headers: { "x-runtime-token": "forged", authorization: "incoming-secret" }, method: "POST" }), {
      ...guard,
      runtimeRoute,
      runtimeHeaders: { "x-runtime-token": "trusted", "content-type": "text/plain", [guard.header]: "forged" },
    })
    const headers = dispatchFetch.mock.calls[0]?.[0].headers
    expect(headers?.get("x-runtime-token")).toBe("trusted")
    expect(headers?.get("content-type")).toBe("application/json")
    expect(headers?.get(guard.header)).toBe(guard.headerValue)
    expect(headers?.get("authorization")).toBeNull()
  })

  it("finds only a Nitro environment that can dispatch requests", () => {
    const nitro = { dispatchFetch: async () => new Response() }
    expect(findViteHubNitroDevEnvironment({ environments: { nitro } })).toBe(nitro)
    expect(findViteHubNitroDevEnvironment({ environments: { nitro: {} } })).toBeUndefined()
    expect(findViteHubNitroDevEnvironment({ environments: { ssr: nitro } })).toBeUndefined()
    expect(findViteHubNitroDevEnvironment({})).toBeUndefined()
  })

  it("prefixes the runtime route with the Nitro base URL", () => {
    expect(viteHubNitroRuntimeRoute(runtimeRoute)).toBe(runtimeRoute)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "/")).toBe(runtimeRoute)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "/app/")).toBe(`/app${runtimeRoute}`)
    expect(viteHubNitroRuntimeRoute(runtimeRoute, "app")).toBe(`/app${runtimeRoute}`)
  })

  it("returns 501 with a clear message when the Vite process has no Nitro environment", async () => {
    const response = await forwardViteHubDevRequestToNitro({}, ...guarded({ body: "{}", method: "POST" }), { ...guard, runtimeRoute })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({
      error: { code: viteHubNitroDevUnavailableCode, message: viteHubNitroDevUnavailableMessage("Test Dev") },
    })
    expect(viteHubNitroDevUnavailableMessage("Test Dev")).toContain("Nuxt and plain Vite are not supported")

    const custom = await forwardViteHubDevRequestToNitro({}, ...guarded({ body: "{}", method: "POST" }), {
      ...guard,
      runtimeRoute,
      unavailable: { code: "TEST_UNAVAILABLE", message: "No test runtime." },
    })
    expect(await custom.json()).toEqual({ error: { code: "TEST_UNAVAILABLE", message: "No test runtime." } })
  })

  it("forwards the body with the guard header under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const response = await forwardViteHubDevRequestToNitro(
      { environments: { nitro: { dispatchFetch } } },
      ...guarded({ body: "{\"operation\":\"list\"}", method: "POST" }),
      { ...guard, nitroBaseURL: () => "/app/", runtimeRoute },
    )

    expect(await response.json()).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${runtimeRoute}` })
    const forwarded = dispatchFetch.mock.calls[0]![0]
    expect(forwarded.method).toBe("POST")
    expect(forwarded.headers.get(guard.header)).toBe(guard.headerValue)
    expect(forwarded.headers.get("content-type")).toBe("application/json")
  })
})

describe("Nitro dev endpoint", () => {
  it("does not forward without the grant of the same request", async () => {
    const dispatchFetch = vi.fn(async () => new Response())
    const [, otherGrant] = guarded({ body: "{}", method: "POST" })
    const req = incoming({ body: "{}", headers: json, method: "POST" })
    await expect(forwardViteHubDevRequestToNitro({ environments: { nitro: { dispatchFetch } } }, req, otherGrant, { ...guard, runtimeRoute }))
      .rejects.toThrow("requires the grant of a checked dev request")
    expect(dispatchFetch).not.toHaveBeenCalled()
  })

  it("checks the Vite guard before it forwards", async () => {
    const dispatchFetch = vi.fn(async () => new Response())
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden Test Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guardHeaders, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guardHeaders, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guardHeaders, method: "DELETE" })).toMatchObject({ status: 405 })
    expect(dispatchFetch).not.toHaveBeenCalled()
  })

  it("reports the runtime on discovery and returns 501 without Nitro", async () => {
    const { middlewares, server } = fakeServer()
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    const discovery = await call(middlewares[0]!, { headers: guardHeaders, method: "GET" })
    expect(discovery.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(discovery.body)).toEqual({ message: viteHubNitroDevUnavailableMessage("Test Dev"), root, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: viteHubNitroDevUnavailableCode } })
  })

  it("forwards operations and does not cache the response", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ url: request.url }, { headers: { "x-runtime": "nitro" } }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, nitroBaseURL: () => "/app/", route, runtimeRoute })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guardHeaders, method: "GET" })).body)).toEqual({ root, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation).toMatchObject({ headers: { "cache-control": "no-store", "x-runtime": "nitro" }, status: 200 })
    expect(JSON.parse(operation.body)).toEqual({ url: `http://localhost/app${runtimeRoute}` })
  })

  it("redacts credentials when forwarding fails", async () => {
    const dispatchFetch = vi.fn(async () => {
      throw new Error("Nitro failed with token=sk_live_secret123456")
    })
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerViteHubNitroDevEndpoint(server, { ...guard, route, runtimeRoute })

    const operation = await call(middlewares[0]!, { body: "{}", headers: json, method: "POST" })
    expect(operation.status).toBe(500)
    expect(operation.body).toContain("Test Dev request failed")
    expect(operation.body).not.toContain("sk_live_secret123456")
  })
})

describe("Nitro dev handler", () => {
  it("returns a grant bound to a guarded JSON POST", async () => {
    const request = nitroRequest()
    const { grant, rejection } = await validateViteHubNitroDevRequest(request, guard)
    expect(rejection).toBeUndefined()
    expect(grant?.label).toBe("Test Dev")
    expect(Object.isFrozen(grant)).toBe(true)
    expect(() => assertViteHubDevRequestGrant(grant!, request)).not.toThrow()
    expect((await validateViteHubNitroDevRequest(nitroRequest({ headers: { ...json, origin: "http://localhost:5173" } }), guard)).grant).toBeDefined()
  })

  it("rejects requests that do not pass the guard", async () => {
    const reject = async (request: Request) => (await validateViteHubNitroDevRequest(request, guard)).rejection
    const missingHeader = await reject(nitroRequest({ headers: { "content-type": "application/json" } }))
    expect(missingHeader?.status).toBe(403)
    expect(await missingHeader?.text()).toBe("Forbidden Test Dev request.")
    expect((await reject(nitroRequest({ headers: { ...json, [guard.header]: "11" } })))?.status).toBe(403)
    expect((await reject(nitroRequest({ headers: { ...json, origin: "https://attacker.test" } })))?.status).toBe(403)
    const get = await reject(nitroRequest({ headers: guardHeaders, method: "GET" }))
    expect(get?.status).toBe(405)
    expect(get?.headers.get("allow")).toBe("POST")
    expect((await reject(nitroRequest({ headers: { ...guardHeaders, "content-type": "text/plain" } })))?.status).toBe(415)
  })

  it("runs owner authorization last and grants only an authorized request", async () => {
    const authorize = vi.fn(async (request: Request) => request.headers.get("x-test-token") === "secret" ? undefined : new Response("Forbidden token.", { status: 403 }))
    const denied = await validateViteHubNitroDevRequest(nitroRequest(), { ...guard, authorize })
    expect(denied.grant).toBeUndefined()
    expect(await denied.rejection?.text()).toBe("Forbidden token.")
    expect((await validateViteHubNitroDevRequest(nitroRequest({ headers: { ...json, "x-test-token": "secret" } }), { ...guard, authorize })).grant).toBeDefined()
    authorize.mockClear()
    await validateViteHubNitroDevRequest(nitroRequest({ headers: { "content-type": "application/json", "x-test-token": "secret" } }), { ...guard, authorize })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("rejects a forged grant, a missing grant, and a grant of another request", async () => {
    const request = nitroRequest()
    const { grant } = await validateViteHubNitroDevRequest(nitroRequest(), guard)
    const message = "[vitehub] This dev-only operation requires the grant of a checked dev request."
    // SAFETY: the test forges a grant at runtime, as JavaScript callers can.
    expect(() => assertViteHubDevRequestGrant({ label: "Test Dev" } as unknown as ViteHubDevRequestGrant, request)).toThrow(message)
    // SAFETY: the test passes no grant at runtime, as JavaScript callers can.
    expect(() => assertViteHubDevRequestGrant(undefined as unknown as ViteHubDevRequestGrant, request)).toThrow(message)
    expect(() => assertViteHubDevRequestGrant(grant!, request)).toThrow(message)
  })

  it("accepts only the loopback host names that the forwarder uses", async () => {
    const at = (url: string, headers: Record<string, string> = json) => new Request(url, { body: "{}", headers, method: "POST" })

    expect(isViteHubNitroDevHostAllowed(at(`http://localhost${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://app.localhost:3000${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://127.0.0.1:3000${runtimeRoute}`))).toBe(true)
    expect(isViteHubNitroDevHostAllowed(at(`http://[::1]:3000${runtimeRoute}`))).toBe(true)

    const { rejection: rebound } = await validateViteHubNitroDevRequest(at(`http://rebound.attacker.test:5173${runtimeRoute}`), guard)
    expect(rebound?.status).toBe(403)
    expect(await rebound?.text()).toBe("Forbidden Test Dev host.")
    expect((await validateViteHubNitroDevRequest(at(`http://localhost${runtimeRoute}`, { ...json, host: "rebound.attacker.test" }), guard)).rejection?.status).toBe(403)
    expect((await validateViteHubNitroDevRequest(at(`http://localhost${runtimeRoute}`, { ...json, host: "localhost:5173" }), guard)).grant).toBeDefined()
  })

  it("keeps the module free of Node value imports, because Worker runtimes load the Nitro-side check", async () => {
    const source = await readFile(new URL("../src/dev-endpoint.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/^import (?!type )[^\n]*from "node:/m)
  })

  it("accepts the request that the forwarder sends", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => (await validateViteHubNitroDevRequest(request, guard)).rejection ?? Response.json({ ok: true }))
    const response = await forwardViteHubDevRequestToNitro(
      { environments: { nitro: { dispatchFetch } } },
      ...guarded({ body: "{}", method: "POST" }),
      { ...guard, nitroBaseURL: () => "/app/", runtimeRoute },
    )
    expect(await response.json()).toEqual({ ok: true })
  })

  it("renders a handler that passes the request to the owner export", () => {
    expect(renderViteHubNitroDevHandler({ export: "handleTestDevRequest", module: "@vite-hub/test/runtime/console" })).toBe([
      "import { defineEventHandler } from 'h3'",
      "import { handleTestDevRequest as handleViteHubDevRequest } from \"@vite-hub/test/runtime/console\"",
      "",
      "export default defineEventHandler(event => handleViteHubDevRequest(event.req))",
      "",
    ].join("\n"))
    expect(renderViteHubNitroDevHandler({ arguments: ['runtime-"key'], export: "handleTestDevRequest", module: "test" })).toContain('handleViteHubDevRequest(event.req, "runtime-\\\"key")')
    expect(() => renderViteHubNitroDevHandler({ export: "default; evil()", module: "x" })).toThrow(TypeError)
  })
})
