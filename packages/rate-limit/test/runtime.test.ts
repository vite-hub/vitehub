import { HTTPError, mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkRateLimit, peekRateLimit, requireRateLimit, resetRateLimit } from "../src/index.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { H3Event } from "h3"

afterEach(() => {
  setRateLimitRuntimeConfig({ provider: "memory" })
  vi.restoreAllMocks()
})

function requestEvent(clientAddress?: string, headers?: Headers | Record<string, string>): H3Event {
  const event = mockEvent("https://example.com/upload", { headers })
  if (clientAddress) Object.assign(event.req, { ip: clientAddress })
  return event
}

function cloudflareEvent(name: string, binding: unknown, headers?: Headers | Record<string, string>): H3Event {
  return Object.assign(requestEvent("192.0.2.1", headers), {
    env: { [getCloudflareRateLimitBindingName(name)]: binding },
  })
}

describe("managed Rate Limit guard", () => {
  it("validates the managed guard contract", async () => {
    const event = requestEvent("192.0.2.10")

    await expect(requireRateLimit(event, "", { limit: 1, window: "1m" })).rejects.toThrow("non-empty stable ID")
    await expect(requireRateLimit(event, "uploads", { limit: 0, window: "1m" })).rejects.toThrow("positive integer")
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "soon" as never })).rejects.toThrow("must use a duration")
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "1m", extra: true } as never)).rejects.toThrow("does not support")
    await expect(requireRateLimit(event, "uploads", { key: "", limit: 1, window: "1m" })).rejects.toThrow("non-empty string")
  })

  it("allows the budget then throws H3 429 with Retry-After", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const event = requestEvent("192.0.2.1")

    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
    try {
      await requireRateLimit(event, "uploads", { limit: 2, window: "1m" })
      expect.unreachable("Expected the request to be limited")
    }
    catch (error) {
      if (!(error instanceof HTTPError)) throw error
      expect(error).toMatchObject({ status: 429, statusText: "Too Many Requests" })
      expect(error.headers?.get("Retry-After")).toBe("30")
    }
  })

  it("keeps an explicit key authoritative over request identity", async () => {
    const event = requestEvent("192.0.2.2")

    await requireRateLimit(event, "identity-uploads", { key: "user", limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "identity-uploads", { limit: 1, window: "1m" })).resolves.toBeUndefined()
    await expect(requireRateLimit(event, "identity-uploads", { key: "user", limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
  })

  it("requires a key when the request has no client address", async () => {
    await expect(requireRateLimit(requestEvent(), "background-uploads", { limit: 1, window: "1m" }))
      .rejects.toThrow("`requireRateLimit()` could not determine a request key")
    await expect(checkRateLimit(requestEvent(), "background-checks", { limit: 1, window: "1m" }))
      .rejects.toThrow("`checkRateLimit()` could not determine a request key")
  })

  it("isolates budgets by stable ID", async () => {
    const event = requestEvent("192.0.2.3")

    await requireRateLimit(event, "uploads", { limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
    await expect(requireRateLimit(event, "searches", { limit: 1, window: "1m" })).resolves.toBeUndefined()
  })

  it("shares counters for equivalent normalized windows", async () => {
    const event = requestEvent("192.0.2.40")

    await requireRateLimit(event, "equivalent-windows", { key: "user", limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "equivalent-windows", { key: "user", limit: 1, window: "60s" }))
      .rejects.toMatchObject({ status: 429 })

    const inspection = await peekRateLimit("equivalent-windows", "user")
    expect(inspection).toMatchObject({ status: "known", counters: [{ limit: 1, used: 1, remaining: 0, windowMs: 60_000 }] })
    if (inspection.status === "known") expect(inspection.counters).toHaveLength(1)
  })

  it("refreshes the memory limiter when a policy changes during development", async () => {
    const event = requestEvent("192.0.2.4")

    await requireRateLimit(event, "uploads", { limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
  })

  it("shares named policy counters between guard, inspection, and reset", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const event = requestEvent("192.0.2.20")
    const name = 'uploads:["tenant"]'
    await Promise.all([
      requireRateLimit(event, name, { key: "user", limit: 3, window: "1m" }),
      requireRateLimit(event, name, { key: "user", limit: 3, window: "1m" }),
    ])
    await requireRateLimit(event, name, { key: "user", limit: 5, window: "1m" })
    await requireRateLimit(event, "other", { key: "user", limit: 3, window: "1m" })

    const inspection = await peekRateLimit(name, "user")
    expect(inspection).toMatchObject({ status: "known", counters: [
      { limit: 3, used: 2, remaining: 1 },
      { limit: 5, used: 1, remaining: 4 },
    ] })
    if (inspection.status === "known") inspection.counters.length = 0
    await expect(resetRateLimit(name, "user")).resolves.toMatchObject({ status: "reset" })
    await expect(peekRateLimit(name, "user")).resolves.toMatchObject({ counters: [
      { limit: 3, used: 0 }, { limit: 5, used: 0 },
    ] })
    await expect(peekRateLimit("other", "user")).resolves.toMatchObject({ counters: [{ used: 1 }] })
  })

  it("clears guard and inspection state when runtime configuration is replaced", async () => {
    const event = requestEvent("192.0.2.21")
    await requireRateLimit(event, "uploads", { key: "user", limit: 1, window: "1m" })
    setRateLimitRuntimeConfig({ provider: "memory" })
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ status: "unused" })
    await expect(requireRateLimit(event, "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toBeUndefined()
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ counters: [{ used: 1 }] })
  })

  it("passes the request event binding and Cloudflare identity directly", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const event = cloudflareEvent("cloudflare-uploads", { limit }, { "cf-connecting-ip": "198.51.100.9" })

    await requireRateLimit(event, "cloudflare-uploads", { limit: 1, window: "1m" })

    expect(limit).toHaveBeenCalledWith({ key: "198.51.100.9" })
  })

  it("limits H3 1 events, because Nuxt 4 bundles every h3 import as its own h3 1", async () => {
    vi.resetModules()
    vi.doMock("h3", () => import("h3-v1"))
    try {
      const { requireRateLimit: requireOnH3V1 } = await import("../src/index.ts")
      const { setRateLimitRuntimeConfig: configure } = await import("../src/runtime.ts")
      const { createApp, eventHandler, toWebHandler } = await import("h3-v1")
      const limit = vi.fn(async ({ key }: { key: string }) => ({ success: key !== "198.51.100.10" }))
      const app = createApp().use(eventHandler(async (event) => {
        event.context.cloudflare = { env: { [getCloudflareRateLimitBindingName("nuxt4-uploads")]: { limit } } }
        await requireOnH3V1(event, "nuxt4-uploads", { limit: 1, window: "1m" })
        return "accepted"
      }))
      const handle = toWebHandler(app)

      configure({ provider: "cloudflare" })
      const allowed = await handle(new Request("https://example.com/upload", { headers: { "cf-connecting-ip": "198.51.100.9" } }))
      const limited = await handle(new Request("https://example.com/upload", { headers: { "cf-connecting-ip": "198.51.100.10" } }))

      expect(allowed.status).toBe(200)
      expect(limited.status).toBe(429)
      expect(limit).toHaveBeenCalledWith({ key: "198.51.100.9" })
      expect(limit).toHaveBeenCalledWith({ key: "198.51.100.10" })
    }
    finally {
      vi.doUnmock("h3")
      vi.resetModules()
    }
  })

  it("sends Retry-After from an H3 1 event", async () => {
    vi.resetModules()
    vi.doMock("h3", () => import("h3-v1"))
    try {
      const { requireRateLimit: requireOnH3V1 } = await import("../src/index.ts")
      const { createApp, eventHandler, toWebHandler } = await import("h3-v1")
      const handle = toWebHandler(createApp().use(eventHandler(async (event) => {
        await requireOnH3V1(event, "nuxt4-retry", { key: "user", limit: 1, window: "1m" })
        return "accepted"
      })))

      expect((await handle(new Request("https://example.com/upload"))).status).toBe(200)
      const limited = await handle(new Request("https://example.com/upload"))

      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    }
    finally {
      vi.doUnmock("h3")
      vi.resetModules()
    }
  })

  it("ignores inherited Cloudflare environment carriers", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const inherited = Object.create({ env: { [getCloudflareRateLimitBindingName("inherited-uploads")]: { limit } } })
    Object.assign(inherited, { req: requestEvent("192.0.2.30").req })

    await expect(requireRateLimit(inherited, "inherited-uploads", { key: "user", limit: 1, window: "1m" }))
      .rejects.toThrow("binding")
    expect(limit).not.toHaveBeenCalled()
  })

  it("throws 503 with the provider cause when fail-closed enforcement is unavailable", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const cause = new Error("provider unavailable")
    const event = cloudflareEvent("unavailable-uploads", {
      limit: async () => { throw cause },
    })

    try {
      await requireRateLimit(event, "unavailable-uploads", { failure: "deny", key: "user", limit: 1, window: "1m" })
      expect.unreachable("Expected rate limiting to be unavailable")
    }
    catch (error) {
      expect(error).toMatchObject({
        cause: { cause },
        status: 503,
        statusText: "Service Unavailable",
      })
    }
  })

  it("does not invent retry metadata for Cloudflare", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const event = cloudflareEvent("metadata-free-uploads", {
      limit: async () => ({ success: false }),
    })

    try {
      await requireRateLimit(event, "metadata-free-uploads", { key: "user", limit: 1, window: "1m" })
      expect.unreachable("Expected the request to be limited")
    }
    catch (error) {
      expect(error).toMatchObject({ status: 429 })
      expect((error as { headers?: Headers }).headers).toBeUndefined()
    }
  })

  it("allows provider unavailability when the policy fails open", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const event = cloudflareEvent("fail-open-uploads", {
      limit: async () => { throw new Error("provider unavailable") },
    })

    await expect(requireRateLimit(event, "fail-open-uploads", {
      failure: "allow",
      key: "user",
      limit: 1,
      window: "1m",
    })).resolves.toBeUndefined()
  })

  it("does not translate a missing binding into an H3 response", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })

    await expect(requireRateLimit(Object.assign(requestEvent("192.0.2.5"), { env: {} }), "missing-binding", {
      key: "user",
      limit: 1,
      window: "1m",
    })).rejects.toThrow("was not found on the request event")
  })
})

describe("non-throwing Rate Limit check", () => {
  it("consumes a token and returns the decision instead of throwing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const event = requestEvent("192.0.2.30")
    const policy = { limit: 2, window: "1m" } as const

    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject({ allowed: true, limit: 2, remaining: 1 })
    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject({ allowed: true, remaining: 0 })
    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject({
      allowed: false,
      reason: "limited",
      retryAfter: 30,
    })
  })

  it("shares counters with requireRateLimit() and peekRateLimit()", async () => {
    const event = requestEvent("192.0.2.31")
    const policy = { key: "user", limit: 2, window: "1m" } as const

    await checkRateLimit(event, "shared", policy)
    await requireRateLimit(event, "shared", policy)
    await expect(peekRateLimit("shared", "user")).resolves.toMatchObject({ counters: [{ used: 2 }] })
    await expect(requireRateLimit(event, "shared", policy)).rejects.toMatchObject({ status: 429 })
    await expect(checkRateLimit(event, "shared", policy)).resolves.toMatchObject({ allowed: false, reason: "limited" })
  })

  it("reports provider unavailability as a decision", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const cause = new Error("provider unavailable")
    const event = cloudflareEvent("unavailable-previews", { limit: async () => { throw cause } })

    const closed = await checkRateLimit(event, "unavailable-previews", { failure: "deny", key: "user", limit: 1, window: "1m" })
    expect(closed).toMatchObject({ allowed: false, reason: "unavailable" })
    expect(closed.cause).toBeDefined()
    await expect(checkRateLimit(event, "unavailable-previews", { failure: "allow", key: "user", limit: 1, window: "1m" }))
      .resolves.toMatchObject({ allowed: true, reason: "unavailable" })
  })

  it("still throws for invalid options", async () => {
    const event = requestEvent("192.0.2.32")
    await expect(checkRateLimit(event, "", { limit: 1, window: "1m" })).rejects.toThrow("`checkRateLimit()` requires a non-empty stable ID")
    await expect(checkRateLimit(event, "previews", { limit: 1, window: "1m", extra: true } as never)).rejects.toThrow("does not support")
  })
})
