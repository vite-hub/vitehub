import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

import { H3Event } from "h3"
import { createEvent } from "h3-v1"
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
