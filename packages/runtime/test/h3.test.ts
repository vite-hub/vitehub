import { H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

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

  it("does not set Standard Context on an event without a request", () => {
    expect(() => installStandardContext({ context: {} })).toThrow(expect.objectContaining({ name: "RUNTIME_R0015" }))
  })
})
