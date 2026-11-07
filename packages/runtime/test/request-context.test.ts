import { H3, H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

import { getRuntimeContext, getStandardContext } from "../src/index.ts"
import { installStandardContext } from "../src/h3.ts"

/** A Request as Nitro 3 and srvx pass it to a Fetchable handler on Cloudflare. */
function cloudflareRequest(url: string) {
  const env = { BUCKET: "request bucket" }
  const waitUntil = vi.fn()
  const request = Object.assign(new Request(url), {
    ip: "203.0.113.7",
    runtime: { cloudflare: { context: { waitUntil }, env }, name: "cloudflare" },
  })
  return { env, request, waitUntil }
}

describe("@vite-hub/runtime request context", () => {
  it("reads host data from the Request of a Fetchable handler", () => {
    const { env, request, waitUntil } = cloudflareRequest("https://example.test/")

    const standard = getStandardContext(request)
    const context = getRuntimeContext(request)
    const work = Promise.resolve()
    context.waitUntil(work)

    expect(standard.vendor).toBe("fetch")
    expect(standard.req).toBe(request)
    expect(standard.runtime).toEqual({ cloudflare: { context: { waitUntil }, env }, clientAddress: "203.0.113.7" })
    expect(getStandardContext(request)).toBe(standard)
    expect(context.request).toBe(request)
    expect(context.event).toBe(request)
    expect(context.cloudflare?.env).toBe(env)
    expect(context.runtime).toBe("cloudflare-agents")
    expect(waitUntil).toHaveBeenCalledWith(work)
  })

  it("prefers the waitUntil that the host sets on the Request", () => {
    const waitUntil = vi.fn()
    const request = Object.assign(new Request("https://example.test/"), { waitUntil })

    const context = getRuntimeContext(request)
    const work = Promise.resolve()
    context.waitUntil(work)

    expect(getStandardContext(request).runtime).toEqual({})
    expect(waitUntil).toHaveBeenCalledWith(work)
  })

  it("keeps a plain Request without host data usable", async () => {
    const request = new Request("https://example.test/")

    const context = getRuntimeContext(request)
    let finished = false
    context.waitUntil(Promise.resolve().then(() => { finished = true }))
    await context.flushWaitUntil()

    expect(getStandardContext(request).waitUntil).toBeUndefined()
    expect(finished).toBe(true)
  })

  it("returns the Standard Context that Nitro set on an event", () => {
    const event = new H3Event(new Request("https://example.test/"))
    installStandardContext(event)

    expect(getStandardContext(event)).toBe(event["~standard"])
    expect(getRuntimeContext(event).event).toBe(event)
  })

  it("rejects an event without Standard Context", () => {
    expect(() => getStandardContext({ context: {} } as never)).toThrowError(expect.objectContaining({ name: "RUNTIME_R0015" }))
  })

  it("gives a Fetchable handler in H3 the event's Standard Context and response headers", async () => {
    const app = new H3()
    app.use((event) => { installStandardContext(event) })
    app.get("/fetchable", {
      fetch(request: Request) {
        getStandardContext(request).res.headers?.set("ratelimit-remaining", "4")
        return new Response("ok", { headers: { "content-type": "text/plain" } })
      },
    })

    const response = await app.fetch(new Request("https://example.test/fetchable"))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(response.headers.get("ratelimit-remaining")).toBe("4")
    expect(response.headers.get("content-type")).toBe("text/plain")
  })
})
