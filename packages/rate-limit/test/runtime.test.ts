import { mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { requireRateLimit } from "../src/index.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { H3Event } from "h3"

afterEach(() => {
  setRateLimitRuntimeConfig({ provider: "memory" })
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

  it("allows requests and then throws an H3 429 response", async () => {
    const event = requestEvent("192.0.2.1")

    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).rejects.toMatchObject({
      status: 429,
      statusText: "Too Many Requests",
    })

    try {
      await requireRateLimit(event, "uploads", { limit: 2, window: "1m" })
    }
    catch (error) {
      expect(Number((error as { headers?: Headers }).headers?.get("Retry-After"))).toBeGreaterThan(0)
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
      .rejects.toThrow("could not determine a request key")
  })

  it("isolates budgets by stable ID", async () => {
    const event = requestEvent("192.0.2.3")

    await requireRateLimit(event, "uploads", { limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
    await expect(requireRateLimit(event, "searches", { limit: 1, window: "1m" })).resolves.toBeUndefined()
  })

  it("refreshes the memory limiter when a policy changes during development", async () => {
    const event = requestEvent("192.0.2.4")

    await requireRateLimit(event, "uploads", { limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
    await expect(requireRateLimit(event, "uploads", { limit: 2, window: "1m" })).resolves.toBeUndefined()
  })

  it("passes the request event binding and Cloudflare identity directly", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const event = cloudflareEvent("cloudflare-uploads", { limit }, { "cf-connecting-ip": "198.51.100.9" })

    await requireRateLimit(event, "cloudflare-uploads", { limit: 1, window: "1m" })

    expect(limit).toHaveBeenCalledWith({ key: "198.51.100.9" })
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
