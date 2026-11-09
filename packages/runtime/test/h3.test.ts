import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

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
})
