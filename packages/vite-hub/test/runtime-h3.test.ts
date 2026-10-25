import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

import { H3Event } from "h3"
import { createEvent } from "h3-v1"
import { Request as MiniflareRequest } from "miniflare"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { runWithActiveCloudflareEnv, getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import type { AgentRuntimeContext } from "@vite-hub/agent"

import { getRuntimeContext, installStandardContext } from "../src/runtime/h3.ts"
import type { ViteHubContext } from "../src/runtime/h3.ts"

const url = "https://example.test/path"

/** An H3 2 event with extra context, as Nitro creates it. */
function h3Event(context: Record<string, unknown> = {}, request: Request = new Request(url)): H3Event {
  const event = new H3Event(request)
  Object.assign(event.context, context)
  return event
}

/** A host event without H3 2's request forwarder for waitUntil. */
function hostEvent<T extends object>(fields: T, request: Request = new Request(url)) {
  const event = { context: {}, req: request, res: { headers: new Headers() }, ...fields }
  installStandardContext(event)
  return event
}

function nodeRequest(fields: object = {}): IncomingMessage {
  return Object.assign(new IncomingMessage(new Socket()), { headers: { host: "example.test" }, method: "GET", url: "/path" }, fields)
}

function spoofed(req: unknown) {
  return { context: {}, req, res: { headers: new Headers() } }
}

describe("H3 Runtime Context", () => {
  const env = { BUCKET: "request bucket" }
  const response = () => ({ headers: new Headers() })
  const request = (owner: object = {}) => Object.assign(new Request(url), owner)
  const node = (req: IncomingMessage) => ({ req, res: new ServerResponse(req) })
  const shapes = [
    (owner: object) => ({ context: {}, env, ...owner, req: request(), res: response() }),
    (owner: object) => ({ context: { ...owner, cloudflare: { env } }, req: request(), res: response() }),
    (owner: object) => ({ context: { cloudflare: { env, ...owner } }, req: request(), res: response() }),
    (owner: object) => ({ context: { cloudflare: { env, context: owner } }, req: request(), res: response() }),
    (owner: object) => ({ context: { _platform: { cloudflare: { env, ...owner } } }, req: request(), res: response() }),
    (owner: object) => ({ context: { _platform: { cloudflare: { env, context: owner } } }, req: request(), res: response() }),
    (owner: object) => ({ context: {}, req: request({ ...owner, runtime: { cloudflare: { env } } }), res: response() }),
    (owner: object) => ({ context: {}, req: request({ runtime: { cloudflare: { env, ...owner } } }), res: response() }),
    (owner: object) => ({ context: {}, req: request({ runtime: { cloudflare: { env, context: owner } } }), res: response() }),
    (owner: object) => ({ context: {}, node: node(nodeRequest({ ...owner, runtime: { cloudflare: { env } } })) }),
    (owner: object) => ({ context: {}, node: node(nodeRequest({ runtime: { cloudflare: { env, ...owner } } })) }),
    (owner: object) => ({ context: {}, node: node(nodeRequest({ runtime: { cloudflare: { env, context: owner } } })) }),
  ]

  it.each(shapes)("normalizes host bindings and preserves the waitUntil receiver %#", async shape => {
    const calls: unknown[] = []
    const marker = {}
    const event = shape({ marker, waitUntil(this: { marker: object }, task: Promise<unknown>) {
      expect(this.marker).toBe(marker)
      calls.push(task)
    } })
    installStandardContext(event)
    expect(event["~standard"].runtime?.cloudflare?.env).toBe(env)
    const context = getRuntimeContext(event)
    expect(context.cloudflare?.env).toBe(env)
    expect(context.runtime).toBe("cloudflare-agents")
    expect(context.event).toBe(event)
    const work = Promise.resolve()
    context.waitUntil(work)
    expect(calls).toEqual([work])
    await context.flushWaitUntil()
  })

  it("accepts H3 1 and H3 2 events", async () => {
    const request = new Request("https://example.test")
    const modern = new H3Event(request)
    const nodeRequest = new IncomingMessage(new Socket())
    const classic = createEvent(nodeRequest, new ServerResponse(nodeRequest))
    const modernContext = getRuntimeContext(modern)
    // SAFETY: The test imports H3 1 as `h3-v1`, which the `h3` module augmentation does not reach. Apps import it as `h3`.
    const classicContext = getRuntimeContext(classic as typeof classic & ViteHubContext)
    expect(modernContext.request).toBe(request)
    expect(classicContext.event).toBe(classic)
    expect(classicContext.request).toBeInstanceOf(Request)
    expectTypeOf(modernContext).toExtend<AgentRuntimeContext>()
    expectTypeOf(classicContext).toExtend<AgentRuntimeContext>()
    await modernContext.flushWaitUntil()
    await classicContext.flushWaitUntil()
  })

  it("rejects an event without a request", () => {
    // SAFETY: The test passes a host object without Standard Context properties on purpose.
    expect(() => getRuntimeContext({ context: {} } as never)).toThrow(expect.objectContaining({ name: "RUNTIME_R0015" }))
  })

  it("preserves Request objects from another host realm", async () => {
    const request = new MiniflareRequest("https://example.test", { method: "POST" })
    const context = getRuntimeContext(new H3Event(request))
    expect(request).not.toBeInstanceOf(Request)
    expect(context.request).toBe(request)
    await context.flushWaitUntil()
  })

  it("preserves cross-realm Requests after their body is consumed", async () => {
    const request = new MiniflareRequest("https://example.test", { body: "payload", method: "POST" })
    await request.text()
    const context = getRuntimeContext(new H3Event(request))
    expect(context.request).toBe(request)
    await context.flushWaitUntil()
  })

  it("accepts a host Request class that only shares the Fetch prototype", async () => {
    // srvx builds its Node request this way: own accessors, with Request.prototype as the prototype.
    class HostRequest {
      get headers() { return new Headers({ host: "example.test" }) }
      get method() { return "GET" }
      get url() { return url }
    }
    Object.setPrototypeOf(HostRequest.prototype, Request.prototype)
    // SAFETY: HostRequest mirrors srvx's Node request, which hosts pass as a Request.
    const request = new HostRequest() as unknown as Request
    const context = getRuntimeContext(h3Event({}, request))
    expect(context.request).toBe(request)
    await context.flushWaitUntil()
  })

  it("does not set Standard Context without a request", () => {
    for (const req of [{ url }, undefined]) {
      expect(() => installStandardContext(spoofed(req))).toThrow(expect.objectContaining({ name: "RUNTIME_R0015" }))
    }
  })

  it("uses a real host lifetime before H3 2's optional request forwarder", async () => {
    const host = { waitUntil: vi.fn() }
    const event = new H3Event(new Request("https://example.test"))
    event.context.cloudflare = { env, context: host }
    const context = getRuntimeContext(event)
    const task = Promise.resolve()
    context.waitUntil(task)
    expect(host.waitUntil).toHaveBeenCalledWith(task)
    expect(host.waitUntil.mock.contexts[0]).toBe(host)
    await context.flushWaitUntil()
  })

  it("keeps bindings and memo values separate across concurrent operations", async () => {
    const ambient = { BUCKET: "ambient" }
    await runWithActiveCloudflareEnv(ambient, async () => {
      await Promise.all(["first", "second"].map(async id => {
        const context = getRuntimeContext(h3Event({ cloudflare: { env: { BUCKET: id } } }))
        const memo = context.memo("identity", () => id)
        await Promise.resolve()
        expect(context.cloudflare?.env?.BUCKET).toBe(id)
        expect(context.memo("identity", () => "wrong")).toBe(memo)
        expect(getActiveCloudflareEnv()).toBe(ambient)
      }))
      expect(getRuntimeContext(h3Event()).cloudflare).toBeUndefined()
    })
  })

  it("lets the caller override host resources with inferred runtime config", async () => {
    const event = h3Event({ cloudflare: { env } })
    const waitUntil = vi.fn()
    const options = { runtime: "vercel" as const, runtimeConfig: { region: "fra1" }, cloudflare: { env: {} }, waitUntil }
    const context = getRuntimeContext(event, options)
    expect(context.runtime).toBe("vercel")
    expect(context.cloudflare).toBe(options.cloudflare)
    expect(context.runtimeConfig).toBe(options.runtimeConfig)
    expectTypeOf(context.runtimeConfig.region).toEqualTypeOf<string>()
    const work = Promise.resolve()
    context.waitUntil(work)
    expect(waitUntil.mock.contexts[0]).toBe(options)
    expect(waitUntil).toHaveBeenCalledWith(work)
    await context.flushWaitUntil()
  })

  it.each([false, true])("honors the explicit Vercel lifetime with event lifetime %s", async (withHost) => {
    const eventOwner = { waitUntil: vi.fn() }
    const vercel = { waitUntil: vi.fn() }
    const context = getRuntimeContext(hostEvent(withHost ? eventOwner : {}), { runtime: "vercel", vercel })
    const first = Promise.resolve()
    const second = Promise.resolve()
    context.waitUntil(first)
    context.vercel?.waitUntil?.(second)
    expect(vercel.waitUntil.mock.calls).toEqual([[first], [second]])
    expect(vercel.waitUntil.mock.contexts).toEqual([vercel, vercel])
    expect(eventOwner.waitUntil).not.toHaveBeenCalled()
    await context.flushWaitUntil()
  })

  it("uses the top-level lifetime before an explicit Vercel lifetime", async () => {
    const options = { runtime: "vercel" as const, vercel: { waitUntil: vi.fn() }, waitUntil: vi.fn() }
    const context = getRuntimeContext(hostEvent({}), options)
    const task = Promise.resolve()
    context.waitUntil(task)
    context.vercel?.waitUntil?.(task)
    expect(options.waitUntil.mock.calls).toEqual([[task], [task]])
    expect(options.waitUntil.mock.contexts).toEqual([options, options])
    expect(options.vercel.waitUntil).not.toHaveBeenCalled()
    await context.flushWaitUntil()
  })

  it("retains failed tasks for an explicit drain without a host lifetime", async () => {
    const context = getRuntimeContext(hostEvent({}))
    const completed = vi.fn()
    context.waitUntil(Promise.reject(new Error("background failed")))
    context.waitUntil(Promise.resolve().then(() => {
      context.waitUntil(Promise.resolve().then(completed))
    }))
    await expect(context.flushWaitUntil()).rejects.toThrow("background failed")
    expect(completed).toHaveBeenCalledOnce()
    await expect(context.flushWaitUntil()).resolves.toBeUndefined()
  })
})

describe("Standard Context for H3 events", () => {
  it("maps an H3 2 event to the Standard Context properties", () => {
    const request = Object.assign(new Request(url), { ip: "203.0.113.7" })
    const host = { waitUntil: vi.fn() }
    const event = h3Event({ cloudflare: { env: { BUCKET: "bucket" }, context: host } }, request)
    installStandardContext(event)
    const standard = event["~standard"]
    installStandardContext(event)

    expect(event["~standard"]).toBe(standard)
    expect(Object.keys(event)).not.toContain("~standard")
    expect(event["~standard"].vendor).toBe("h3")
    expect(event["~standard"].req).toBe(request)
    expect(event["~standard"].runtime).toEqual({ cloudflare: { env: { BUCKET: "bucket" }, context: host }, clientAddress: "203.0.113.7" })

    const res = event["~standard"].res
    res.status = 201
    res.headers?.set("x-test", "yes")
    expect(event.res.status).toBe(201)
    expect(event.res.headers.get("x-test")).toBe("yes")
    expect(() => { res.body = "body" }).toThrow(expect.objectContaining({ name: "RUNTIME_R0016" }))

    const task = Promise.resolve()
    event["~standard"].waitUntil?.(task)
    expect(host.waitUntil).toHaveBeenCalledWith(task)
  })

  it("keeps the Standard Context that a host already set", () => {
    const standard = { vendor: "custom", req: new Request(url), res: { headers: new Headers() } }
    const event = { "~standard": standard }
    installStandardContext(event)
    expect(event["~standard"]).toBe(standard)
  })

  it("maps an H3 1 event and builds its Request on first read", async () => {
    const req = nodeRequest({ method: "POST", url: "/upload", headers: { "content-type": "text/plain", host: "example.test" } })
    const res = new ServerResponse(req)
    const event = createEvent(req, res)
    installStandardContext(event)
    const standard = event["~standard"]
    queueMicrotask(() => {
      req.push("payload")
      req.push(null)
    })

    expect(standard.vendor).toBe("h3")
    expect(standard.req).toBe(standard.req)
    expect(standard.req.url).toBe("http://example.test/upload")
    expect(await standard.req.text()).toBe("payload")

    standard.res.status = 202
    standard.res.headers?.set("x-test", "yes")
    standard.res.headers?.append("set-cookie", "a=1")
    standard.res.headers?.append("set-cookie", "b=2")
    expect(res.statusCode).toBe(202)
    expect(res.getHeader("x-test")).toBe("yes")
    expect(standard.res.headers?.getSetCookie()).toEqual(["a=1", "b=2"])
    standard.res.headers?.delete("x-test")
    expect(res.hasHeader("x-test")).toBe(false)
  })
})
