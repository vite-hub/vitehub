import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"
import { toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"

import { getRuntimeContext, getStandardContext, installStandardContext } from "../src/h3.ts"

describe("@vite-hub/runtime/h3", () => {
  it("reads the Cloudflare env and lifetime from an H3 event", () => {
    const env = { BUCKET: "request bucket" }
    const waitUntil = vi.fn()
    const request = new Request("https://example.test/")
    const event = new H3Event(request)
    event.context.cloudflare = { env, context: { waitUntil } }

    const context = getRuntimeContext(event)
    const work = Promise.resolve()
    context.waitUntil(work)

    expect(context.runtime).toBe("cloudflare-agents")
    expect(context.cloudflare?.env).toBe(env)
    expect(context.event).toBe(event)
    expect(context.request).toBe(request)
    expect(waitUntil).toHaveBeenCalledWith(work)
  })

  it("keeps an explicit runtime and waitUntil", () => {
    const waitUntil = vi.fn()
    const context = getRuntimeContext(new H3Event(new Request("https://example.test/")), { runtime: "vercel", waitUntil })
    const work = Promise.resolve()
    context.waitUntil(work)

    expect(context.runtime).toBe("vercel")
    expect(context.vercel?.waitUntil).toBeTypeOf("function")
    expect(waitUntil).toHaveBeenCalledWith(work)
  })

  it("accepts an explicit request for a synthetic event", () => {
    const request = new Request("https://example.test/synthetic")
    const event = { context: {} }

    const context = getRuntimeContext(event as never, { request })

    expect(context.request).toBe(request)
    expect(event).not.toHaveProperty("~standard")
  })

  it("keeps H3 resources when replacing the request", () => {
    const env = { BUCKET: "request bucket" }
    const hostRequest = new Request("https://example.test/host")
    const override = new Request("https://example.test/override")
    const event = new H3Event(hostRequest)
    event.context.cloudflare = { env }

    const context = getRuntimeContext(event, { request: override })

    expect(context.request).toBe(override)
    expect(context.cloudflare?.env).toBe(env)
    expect(event["~standard"].req).toBe(hostRequest)
  })

  it("reads the event only on the first read of a Standard Context property", () => {
    const reads = { context: 0, res: 0 }
    const response = { headers: new Headers() }
    const context = { cloudflare: { env: { BUCKET: "bucket" }, context: { waitUntil: vi.fn() } } }
    const event = {
      req: new Request("https://example.test/"),
      get context() {
        reads.context++
        return context
      },
      get res() {
        reads.res++
        return response
      },
    }

    installStandardContext(event)
    expect(reads).toEqual({ context: 0, res: 0 })

    const standard = event["~standard"]
    const { res, runtime, waitUntil } = standard
    expect(reads.res).toBe(1)
    const afterFirstRead = { ...reads }
    expect(standard.res).toBe(res)
    expect(standard.runtime).toBe(runtime)
    expect(standard.waitUntil).toBe(waitUntil)
    expect(reads).toEqual(afterFirstRead)
  })

  it("returns Standard Context and sets it when Nitro did not", () => {
    const req = new Request("https://example.test/")
    const event = { req, res: { headers: new Headers() } }

    const standard = getStandardContext(event as never)
    expect(standard.req).toBe(req)
    expect(getStandardContext(event as never)).toBe(standard)

    const hostStandard = { vendor: "host", req, res: {} }
    expect(getStandardContext({ "~standard": hostStandard })).toBe(hostStandard)
    expect(() => getStandardContext({} as never)).toThrow(expect.objectContaining({ name: "RUNTIME_R0015" }))
  })

  it("reads the peer address from each host carrier", () => {
    const h3V2 = (request: Request) => {
      const event = { req: request, res: { headers: new Headers() } }
      installStandardContext(event)
      return event["~standard"].runtime?.clientAddress
    }
    const request = (fields: Record<string, unknown>) => Object.assign(new Request("http://localhost/"), fields)
    // A host adapter sets `request.context.clientAddress`, as H3 2's getRequestIP() reads it.
    expect(h3V2(request({ context: { clientAddress: "203.0.113.7" } }))).toBe("203.0.113.7")
    expect(h3V2(request({ ip: "203.0.113.8" }))).toBe("203.0.113.8")
    expect(h3V2(request({ runtime: { node: { req: { socket: { remoteAddress: "203.0.113.9" } } } } }))).toBe("203.0.113.9")
    expect(h3V2(request({ context: { clientAddress: "" }, ip: "203.0.113.10" }))).toBe("203.0.113.10")
    expect(h3V2(new Request("http://localhost/", { headers: { "x-forwarded-for": "198.51.100.1" } }))).toBeUndefined()

    const h3V1 = { context: { clientAddress: "203.0.113.11" }, node: { req: { headers: { host: "localhost" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} }, res: { getHeader: vi.fn(), getHeaders: () => ({}), removeHeader: vi.fn(), setHeader: vi.fn(), statusCode: 200 } } }
    installStandardContext(h3V1)
    expect(h3V1["~standard"].runtime?.clientAddress).toBe("203.0.113.11")
  })

  it("keeps the Cloudflare execution context when the event has no bindings", () => {
    const waitUntil = vi.fn()
    const context = { waitUntil, passThroughOnException: vi.fn() }
    const event = new H3Event(new Request("https://example.test/"))
    event.context.cloudflare = { context }

    expect(getStandardContext(event).runtime?.cloudflare).toEqual({ context })
    expect(getRuntimeContext(event).runtime).toBe("cloudflare-agents")
  })

  it("does not set Standard Context on an event without a request", () => {
    expect(() => installStandardContext({ context: {} })).toThrow(expect.objectContaining({ name: "RUNTIME_R0015" }))
  })

  it("does not pull an H3 1 body until the Request is read", async () => {
    let pulls = 0
    const nodeRequest = {
      headers: { host: "example.test" },
      method: "POST",
      url: "/",
      async *[Symbol.asyncIterator]() {
        pulls++
        yield "body"
      },
    }
    const request = toH3V1Request({ node: { req: nodeRequest } })
    await Promise.resolve()
    expect(pulls).toBe(0)
    await expect(request.text()).resolves.toBe("body")
    expect(pulls).toBe(1)
  })

  it.each([
    ["_requestBody", Promise.resolve(new TextEncoder().encode('{"action":"list"}'))],
    ["_requestBody", { action: "list" }],
    ["h3RawBody", new TextEncoder().encode('{"action":"list"}')],
    ["rawBody", '{"action":"list"}'],
    ["body", '{"action":"list"}'],
  ] as const)("reads an H3 1 body that a host or middleware already read: %s", async (key, stored) => {
    const nodeRequest: Record<PropertyKey, unknown> = {
      headers: { host: "docs.example", "content-type": "application/json" },
      method: "POST",
      url: "/_vitehub/connections",
      // Nitro 2 on Cloudflare Workers gives a request mock that cannot be iterated.
      [Symbol.asyncIterator]: () => { throw new Error("Readable.asyncIterator is not implemented yet!") },
    }
    const event: Record<string, unknown> = { node: { req: nodeRequest } }
    if (key === "_requestBody") event._requestBody = stored
    else nodeRequest[key === "h3RawBody" ? Symbol.for("h3RawBody") : key] = stored
    await expect(toH3V1Request(event as never).json()).resolves.toEqual({ action: "list" })
  })

  it("keeps the app base path and the TLS scheme of an H3 1 request", () => {
    const nodeRequest = {
      headers: { host: "docs.example", "x-forwarded-proto": "https" },
      method: "GET",
      originalUrl: "/portal/_vitehub/connections/callback?code=test",
      url: "/_vitehub/connections/callback?code=test",
    }
    expect(toH3V1Request({ node: { req: nodeRequest } }).url).toBe("https://docs.example/portal/_vitehub/connections/callback?code=test")
    const slashes = { ...nodeRequest, originalUrl: "//other.example/portal" }
    expect(toH3V1Request({ node: { req: slashes } }).url).toBe("https://docs.example/other.example/portal")
  })

  it.each(["request", "h3"] as const)("gives the Web Request and H3's body cache the same H3 1 body when %s reads first", async (first) => {
    const nodeRequest = {
      headers: { host: "example.test" },
      method: "POST",
      url: "/",
      async *[Symbol.asyncIterator]() {
        yield "one,"
        yield "two"
      },
    }
    const event: { _requestBody?: unknown, node: { req: typeof nodeRequest } } = { node: { req: nodeRequest } }
    const request = toH3V1Request(event)
    // The H3 body cache appears once the Web body is opened.
    const reader = request.body!.getReader()
    const decoder = new TextDecoder()
    let text = decoder.decode((await reader.read()).value)
    const cached = () => Promise.resolve(event._requestBody).then(bytes => decoder.decode(bytes as Uint8Array))
    if (first === "h3") await expect(cached()).resolves.toBe("one,two")
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value)

    expect(text).toBe("one,two")
    await expect(cached()).resolves.toBe("one,two")
  })

  it("closes the Node stream and drops the H3 body cache when the Web body is cancelled", async () => {
    let reads = 0
    let closed = false
    const nodeRequest = {
      headers: { host: "example.test" },
      method: "POST",
      url: "/",
      async *[Symbol.asyncIterator]() {
        try {
          for (let index = 0; index < 10; index++) {
            reads++
            yield "chunk"
          }
        }
        finally { closed = true }
      },
    }
    const event: { _requestBody?: unknown, node: { req: typeof nodeRequest } } = { node: { req: nodeRequest } }
    const reader = toH3V1Request(event).body!.getReader()
    await reader.read()
    await reader.cancel()

    expect(reads).toBe(1)
    expect(closed).toBe(true)
    await expect(Promise.resolve(event._requestBody)).rejects.toThrow("cancelled")
  })

  it("closes an empty H3 1 request body", async () => {
    const nodeRequest = {
      headers: { host: "example.test" },
      method: "POST",
      url: "/",
      async *[Symbol.asyncIterator]() {},
    }
    await expect(toH3V1Request({ node: { req: nodeRequest } }).text()).resolves.toBe("")
  })
})
