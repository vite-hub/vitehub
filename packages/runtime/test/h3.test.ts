import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"
import { toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"

import { getRuntimeContext, installStandardContext } from "../src/h3.ts"

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
