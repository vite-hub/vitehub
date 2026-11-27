import { H3, H3Event } from "h3"
import { describe, expect, it, vi } from "vitest"

import { getRuntimeContext, getStandardContext } from "../src/index.ts"
import { installStandardContext, sendPreparedResponse } from "../src/internal/h3.ts"

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

  it("keeps host data and the same context on a non-extensible Request", () => {
    const { env, request, waitUntil } = cloudflareRequest("https://example.test/")
    Object.preventExtensions(request)

    const standard = getStandardContext(request)
    const context = getRuntimeContext(request)
    const work = Promise.resolve()
    context.waitUntil(work)

    expect(getStandardContext(request)).toBe(standard)
    expect(standard.req).toBe(request)
    expect(context.cloudflare?.env).toBe(env)
    expect(waitUntil).toHaveBeenCalledWith(work)
    expect(request).not.toHaveProperty("~standard")
  })

  it("shares the H3 event context with a non-extensible Request", () => {
    const request = new Request("https://example.test/")
    const event = new H3Event(request)
    Object.preventExtensions(request)
    const env = { BUCKET: "event bucket" }
    event.context.cloudflare = { env }
    installStandardContext(event)

    expect(getStandardContext(request)).toBe(getStandardContext(event))
    expect(getRuntimeContext(request).cloudflare?.env).toBe(env)
    expect(request).not.toHaveProperty("~standard")
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

  it.each([200, 429, 500])("keeps Standard Context headers on a returned %s Response in H3", async (status) => {
    const app = new H3()
    app.use((event) => { installStandardContext(event) })
    app.get("/fetchable", {
      fetch(request: Request) {
        const res = getStandardContext(request).res
        res.headers = new Headers({ "ratelimit-remaining": "5", "x-remove": "unused" })
        res.headers.set("ratelimit-remaining", "4")
        res.headers.delete("x-remove")
        res.headers.append("set-cookie", "first=1; Path=/")
        res.headers.append("set-cookie", "second=2; Path=/")
        return new Response("ok", { status, headers: { "content-type": "text/plain" } })
      },
    })

    const response = await app.fetch(new Request("https://example.test/fetchable"))

    expect(response.status).toBe(status)
    expect(await response.text()).toBe("ok")
    expect(response.headers.get("ratelimit-remaining")).toBe("4")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.has("x-remove")).toBe(false)
    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/"])
  })

  it("adds the prepared response of a plain Fetch host to a Response as H3 does, once", async () => {
    const request = new Request("https://example.test/fetchable")
    const res = getStandardContext(request).res
    res.headers?.set("ratelimit-remaining", "4")
    res.headers?.append("set-cookie", "first=1; Path=/")
    const returned = new Response("ok", { headers: { "content-type": "text/plain", "ratelimit-remaining": "9", "set-cookie": "own=1; Path=/" }, status: 201 })

    const response = sendPreparedResponse(request, returned)

    expect(response.status).toBe(201)
    expect(await response.text()).toBe("ok")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.get("ratelimit-remaining")).toBe("4")
    expect(response.headers.getSetCookie()).toEqual(["own=1; Path=/", "first=1; Path=/"])
    expect([...res.headers ?? []]).toEqual([])
    const again = new Response("ok")
    expect(sendPreparedResponse(request, again)).toBe(again)
  })

  it("leaves the prepared response of an H3 event to H3", async () => {
    const app = new H3()
    app.use((event) => { installStandardContext(event) })
    let returned: Response | undefined
    app.get("/fetchable", {
      fetch(request: Request) {
        getStandardContext(request).res.headers?.append("set-cookie", "first=1; Path=/")
        returned = new Response("ok")
        return sendPreparedResponse(request, returned)
      },
    })

    const response = await app.fetch(new Request("https://example.test/fetchable"))

    expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/"])
    expect(returned?.headers.getSetCookie()).toEqual([])
  })
})
