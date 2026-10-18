import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

import { H3Event } from "h3"
import { createEvent } from "h3-v1"
import { Request as MiniflareRequest } from "miniflare"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { runWithActiveCloudflareEnv, getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import type { AgentRuntimeContext } from "@vite-hub/agent"

import { getRuntimeContext } from "../src/runtime/h3.ts"

describe("H3 Runtime Context", () => {
  const env = { BUCKET: "request bucket" }
  const shapes = [
    (owner: object) => ({ context: {}, env, ...owner }),
    (owner: object) => ({ context: { ...owner, cloudflare: { env } } }),
    (owner: object) => ({ context: { cloudflare: { env, ...owner } } }),
    (owner: object) => ({ context: { cloudflare: { env, context: owner } } }),
    (owner: object) => ({ context: { _platform: { cloudflare: { env, ...owner } } } }),
    (owner: object) => ({ context: { _platform: { cloudflare: { env, context: owner } } } }),
    (owner: object) => ({ context: {}, req: { ...owner, runtime: { cloudflare: { env } } } }),
    (owner: object) => ({ context: {}, req: { runtime: { cloudflare: { env, ...owner } } } }),
    (owner: object) => ({ context: {}, req: { runtime: { cloudflare: { env, context: owner } } } }),
    (owner: object) => ({ context: {}, node: { req: { ...owner, runtime: { cloudflare: { env } } } } }),
    (owner: object) => ({ context: {}, node: { req: { runtime: { cloudflare: { env, ...owner } } } } }),
    (owner: object) => ({ context: {}, node: { req: { runtime: { cloudflare: { env, context: owner } } } } }),
  ]

  it.each(shapes)("normalizes host bindings and preserves the waitUntil receiver %#", async shape => {
    const calls: unknown[] = []
    const marker = {}
    const event = shape({ marker, waitUntil(this: { marker: object }, task: Promise<unknown>) {
      expect(this.marker).toBe(marker)
      calls.push(task)
    } })
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
    const classicContext = getRuntimeContext(classic)
    expect(modernContext.request).toBe(request)
    expect(classicContext.event).toBe(classic)
    expectTypeOf(modernContext).toExtend<AgentRuntimeContext>()
    expectTypeOf(classicContext).toExtend<AgentRuntimeContext>()
    await modernContext.flushWaitUntil()
    await classicContext.flushWaitUntil()
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

  it("rejects objects that only spoof the Request tag", async () => {
    const context = getRuntimeContext({ context: {}, req: { [Symbol.toStringTag]: "Request" } })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a tag spoof with a candidate-owned clone method", async () => {
    const context = getRuntimeContext({ context: {}, req: { [Symbol.toStringTag]: "Request", clone: () => ({}) } })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a forged Request prototype with copied methods", async () => {
    const requestPrototype = Object.getPrototypeOf(new Request("https://example.test"))
    const prototype = Object.create(requestPrototype, {
      constructor: { value: Object.assign(function Request() {}, { prototype: undefined }) },
      headers: { get: () => new Headers() },
      url: { get: () => "https://example.test" },
      method: { get: () => "GET" },
      bodyUsed: { get: () => true },
      signal: { get: () => new AbortController().signal },
      clone: { value: requestPrototype.clone },
      arrayBuffer: { value: requestPrototype.arrayBuffer },
      blob: { value: requestPrototype.blob },
      formData: { value: requestPrototype.formData },
      json: { value: requestPrototype.json },
      text: { value: requestPrototype.text },
    })
    prototype.constructor.prototype = prototype
    const context = getRuntimeContext({ context: {}, req: Object.create(prototype) })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects accessors that depend on the candidate prototype", async () => {
    const prototype = Object.create(null, {
      constructor: { value: Object.assign(function Request() {}, { prototype: undefined }) },
      bodyUsed: { get() {
        if (Object.getPrototypeOf(this) === prototype) return false
        throw new TypeError("invalid receiver")
      } },
      headers: { get: () => new Headers() },
      url: { get: () => "https://example.test" },
      method: { get: () => "GET" },
    })
    prototype.constructor.prototype = prototype
    const context = getRuntimeContext({ context: {}, req: Object.create(prototype) })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a consumed spoof with a rejected arrayBuffer promise", async () => {
    const requestPrototype = Object.getPrototypeOf(new Request("https://example.test"))
    const prototype = Object.create(requestPrototype, {
      constructor: { value: Object.assign(function Request() {}, { prototype: undefined }) },
      headers: { get: () => new Headers() },
      url: { get: () => "https://example.test" },
      method: { get: () => "GET" },
      bodyUsed: { get: () => true },
      signal: { get: () => new AbortController().signal },
      clone: { value: () => { throw new Error("consumed") } },
      arrayBuffer: { value: () => Promise.reject(new Error("forged")) },
      blob: { value: () => Promise.resolve(new Blob()) },
      formData: { value: () => Promise.reject(new Error("forged")) },
      json: { value: () => Promise.reject(new Error("forged")) },
      text: { value: () => Promise.reject(new Error("forged")) },
    })
    prototype.constructor.prototype = prototype
    const context = getRuntimeContext({ context: {}, req: Object.create(prototype) })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a Request-shaped custom prototype", async () => {
    const prototype = {
      headers: new Headers(),
      url: "https://example.test",
      method: "GET",
      bodyUsed: false,
      clone: () => ({}),
      [Symbol.toStringTag]: "Request",
    }
    const context = getRuntimeContext({ context: {}, req: Object.create(prototype) })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a request with a throwing tag getter", async () => {
    const request = Object.defineProperty({}, Symbol.toStringTag, {
      get: () => { throw new Error("spoofed tag") },
    })
    const context = getRuntimeContext({ context: {}, req: request })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a request proxy with a cyclic prototype", async () => {
    const request = new Proxy({}, {
      getPrototypeOf: () => request,
    })
    const context = getRuntimeContext({ context: {}, req: request })
    expect(context.request).toBeUndefined()
    await context.flushWaitUntil()
  })

  it("rejects a request proxy with an unbounded fresh prototype chain", () => {
    const request = new Proxy({}, {
      getPrototypeOf() {
        const prototype = {}
        Object.defineProperty(prototype, "constructor", { value: function ProxyPrototype() {} })
        return prototype
      },
    })

    expect(getRuntimeContext({ context: {}, req: request }).request).toBeUndefined()
  })

  it("rejects foreign requests beyond the documented prototype-depth ceiling", () => {
    const request = new MiniflareRequest("https://example.test")
    let prototype = Object.getPrototypeOf(request)
    for (let index = 0; index <= 16_384; index++) {
      prototype = Object.create(prototype, {
        constructor: { value: function ForeignRequestSubclass() {} },
      })
    }
    Object.setPrototypeOf(request, prototype)
    expect(getRuntimeContext(new H3Event(request)).request).toBeUndefined()
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
        const event = { context: { cloudflare: { env: { BUCKET: id } } } }
        const context = getRuntimeContext(event)
        const memo = context.memo("identity", () => id)
        await Promise.resolve()
        expect(context.cloudflare?.env?.BUCKET).toBe(id)
        expect(context.memo("identity", () => "wrong")).toBe(memo)
        expect(getActiveCloudflareEnv()).toBe(ambient)
      }))
      expect(getRuntimeContext({ context: {} }).cloudflare).toBeUndefined()
    })
  })

  it("lets the caller override host resources with inferred runtime config", async () => {
    const event = { context: { cloudflare: { env } } }
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
    const context = getRuntimeContext({ context: {}, ...(withHost ? eventOwner : {}) }, { runtime: "vercel", vercel })
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
    const context = getRuntimeContext({ context: {} }, options)
    const task = Promise.resolve()
    context.waitUntil(task)
    context.vercel?.waitUntil?.(task)
    expect(options.waitUntil.mock.calls).toEqual([[task], [task]])
    expect(options.waitUntil.mock.contexts).toEqual([options, options])
    expect(options.vercel.waitUntil).not.toHaveBeenCalled()
    await context.flushWaitUntil()
  })

  it("retains failed tasks for an explicit drain without a host lifetime", async () => {
    const context = getRuntimeContext({ context: {} })
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
