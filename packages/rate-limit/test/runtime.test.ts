import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRequestLogger, initLogger } from "evlog"
import { H3, HTTPError, mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkRateLimit, peekRateLimit, refundRateLimit, requireRateLimit, resetRateLimit } from "../src/index.ts"
import { getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { H3Event } from "h3"

afterEach(() => {
  setRateLimitRuntimeConfig({ driver: "memory" })
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
    await expect(requireRateLimit(event, "uploads", { limit: 1, window: "soon" as never })).rejects.toThrow("is not a duration")
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

  it("sends Retry-After on the 429 response of an H3 app", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const app = new H3().post("/api/demo/session", async (event) => {
      await requireRateLimit(event, "demo-session", { key: "visitor", limit: 1, window: "1m" })
      return { started: true }
    })
    const post = () => app.fetch(new Request("https://joxi.test/api/demo/session", { method: "POST" }))

    expect((await post()).status).toBe(200)
    const limited = await post()
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("30")
  })

  it("throws the 429 with the message and code of the call", async () => {
    const event = requestEvent("192.0.2.5")
    const options = { code: "errorTooManyTries", key: "user", limit: 1, message: "Too many tries. Wait a minute and try again.", window: "1m" } as const

    await requireRateLimit(event, "worded-uploads", options)
    const error = await requireRateLimit(event, "worded-uploads", options).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(HTTPError)
    expect(error).toMatchObject({ data: { code: "errorTooManyTries" }, message: "Too many tries. Wait a minute and try again.", status: 429 })
    expect((error as HTTPError).headers?.get("Retry-After")).toBeTruthy()
  })

  it("rejects an empty message or code before it consumes a token", async () => {
    const event = requestEvent("192.0.2.6")

    await expect(requireRateLimit(event, "worded-previews", { key: "user", limit: 1, message: " ", window: "1m" }))
      .rejects.toMatchObject({ code: "RATE_LIMIT_REFUSAL_OPTION_INVALID" })
    await expect(requireRateLimit(event, "worded-previews", { code: 42 as never, key: "user", limit: 1, window: "1m" }))
      .rejects.toMatchObject({ code: "RATE_LIMIT_REFUSAL_OPTION_INVALID" })
    await expect(peekRateLimit("worded-previews", "user")).resolves.toMatchObject({ status: "unused" })
  })

  it("refuses with the configured message, and checkRateLimit() rejects a message", async () => {
    const event = requestEvent("192.0.2.3")
    const message = "Too many tries. Wait a minute and try again."

    await requireRateLimit(event, "sign-in", { limit: 1, message, window: "1m" })
    await expect(requireRateLimit(event, "sign-in", { limit: 1, message, window: "1m" })).rejects.toMatchObject({ message, status: 429, statusText: "Too Many Requests" })
    await expect(requireRateLimit(event, "sign-in", { limit: 1, window: "1m" })).rejects.toMatchObject({ message: "Rate limit exceeded.", status: 429 })
    // @ts-expect-error A Result has no refusal to name.
    await expect(checkRateLimit(event, "sign-in", { limit: 1, message, window: "1m" })).rejects.toThrow('`checkRateLimit()` does not support the "message" option.')
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
    const [error, decision] = await checkRateLimit(requestEvent(), "background-checks", { limit: 1, window: "1m" })
    expect(decision).toBeUndefined()
    expect(error).toMatchObject({ code: "RATE_LIMIT_R0013", message: expect.stringContaining("`checkRateLimit()` could not determine a request key") })
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
    setRateLimitRuntimeConfig({ driver: "memory" })
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ status: "unused" })
    await expect(requireRateLimit(event, "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toBeUndefined()
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ counters: [{ used: 1 }] })
  })

  it("passes the request event binding and Cloudflare identity directly", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const event = cloudflareEvent("cloudflare-uploads", { limit }, { "cf-connecting-ip": "198.51.100.9" })

    await requireRateLimit(event, "cloudflare-uploads", { limit: 1, window: "1m" })

    expect(limit).toHaveBeenCalledWith({ key: "198.51.100.9" })
  })

  it("reads only the Standard Context that the host set", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const event = {
      "~standard": {
        vendor: "test",
        req: new Request("https://example.com/upload", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
        res: { headers: new Headers() },
        runtime: { cloudflare: { env: { [getCloudflareRateLimitBindingName("standard-uploads")]: { limit } } } },
      },
      headers: new Headers({ "cf-connecting-ip": "192.0.2.99" }),
      env: { [getCloudflareRateLimitBindingName("standard-uploads")]: { limit: vi.fn() } },
    }

    await requireRateLimit(event, "standard-uploads", { limit: 1, window: "1m" })

    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" })
  })

  it("limits a Web Request by its key", async () => {
    const request = new Request("https://example.com/upload")

    vi.spyOn(Date, "now").mockReturnValue(30_000)
    await requireRateLimit(request, "request-uploads", { key: "user", limit: 1, window: "1m" })
    const limited: unknown = await requireRateLimit(request, "request-uploads", { key: "user", limit: 1, window: "1m" }).catch((error: unknown) => error)

    if (!(limited instanceof HTTPError)) throw new Error("Expected the request to be limited")
    expect(limited).toMatchObject({ status: 429 })
    expect(limited.headers?.get("Retry-After")).toBe("30")
    await expect(checkRateLimit(request, "request-checks", { limit: 1, window: "1m" }))
      .resolves.toMatchObject([{ code: "RATE_LIMIT_R0013" }, undefined])
  })

  it("shares a budget across equivalent decimal windows", async () => {
    const request = new Request("https://example.com/upload")
    vi.spyOn(Date, "now").mockReturnValue(30_000)

    await expect(checkRateLimit(request, "decimal-window", { key: "user", limit: 1, window: "2.007 seconds" }))
      .resolves.toMatchObject([undefined, { allowed: true }])
    await expect(checkRateLimit(request, "decimal-window", { key: "user", limit: 1, window: "2007ms" }))
      .resolves.toMatchObject([undefined, { allowed: false }])
  })

  it("reads the Cloudflare address header and the active bindings for a Web Request", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const request = new Request("https://example.com/upload", { headers: { "cf-connecting-ip": "203.0.113.9" } })

    await runWithActiveCloudflareEnv({ [getCloudflareRateLimitBindingName("request-cloudflare")]: { limit } }, () =>
      requireRateLimit(request, "request-cloudflare", { limit: 1, window: "1m" }))

    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" })
  })

  it.each(["req", "node", "~standard"])("limits request-shaped inputs with unrelated %s metadata", async (property) => {
    for (const inherited of [false, true]) {
      const request = { headers: new Headers() }
      const metadata = { [property]: { source: "application" } }
      if (inherited) Object.setPrototypeOf(request, metadata)
      else Object.assign(request, metadata)
      const name = `request-metadata-${property}-${inherited}`
      const options = { key: "user", limit: 1, window: "1m" } as const

      await expect(checkRateLimit(request, name, options)).resolves.toMatchObject([undefined, { allowed: true }])
      await expect(requireRateLimit(request, name, options)).rejects.toMatchObject({ status: 429 })
      await expect(checkRateLimit(request, name, { limit: 1, window: "1m" }))
        .resolves.toMatchObject([{ code: "RATE_LIMIT_R0013" }, undefined])
    }
  })

  it("uses request headers and active Cloudflare bindings despite event-named metadata", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const request = {
      headers: new Headers({ "cf-connecting-ip": "203.0.113.10" }),
      req: { source: "application" },
      node: { version: "24" },
      "~standard": { vendor: "application" },
    }

    await runWithActiveCloudflareEnv({ [getCloudflareRateLimitBindingName("request-metadata-cloudflare")]: { limit } }, () =>
      requireRateLimit(request, "request-metadata-cloudflare", { limit: 1, window: "1m" }))

    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.10" })
  })

  it("counts by the Standard Context client address", async () => {
    const event = {
      "~standard": {
        vendor: "test",
        req: new Request("https://example.com/upload"),
        res: { headers: new Headers() },
        runtime: { clientAddress: "203.0.113.8" },
      },
    }

    await requireRateLimit(event, "standard-address", { limit: 1, window: "1m" })
    await expect(peekRateLimit("standard-address", "203.0.113.8")).resolves.toMatchObject({ counters: [{ used: 1 }] })
  })

  it("ignores inherited Cloudflare environment carriers", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const inherited = Object.create({ env: { [getCloudflareRateLimitBindingName("inherited-uploads")]: { limit } } })
    const { req, res } = requestEvent("192.0.2.30")
    Object.assign(inherited, { req, res })

    await expect(requireRateLimit(inherited, "inherited-uploads", { key: "user", limit: 1, window: "1m" }))
      .rejects.toThrow("binding")
    expect(limit).not.toHaveBeenCalled()
  })

  it("throws 503 with the provider cause when fail-closed enforcement is unavailable", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
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
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
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
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
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
    setRateLimitRuntimeConfig({ driver: "cloudflare" })

    await expect(requireRateLimit(Object.assign(requestEvent("192.0.2.5"), { env: {} }), "missing-binding", {
      key: "user",
      limit: 1,
      window: "1m",
    })).rejects.toThrow("was not found on the request event")
  })
})

describe("Rate Limit refund", () => {
  it("gives back one request of the same ID, policy, and key", async () => {
    const event = requestEvent("192.0.2.40")
    const policy = { key: "learner", limit: 1, window: "1d" } as const

    await requireRateLimit(event, "tutor", policy)
    await expect(requireRateLimit(event, "tutor", policy)).rejects.toMatchObject({ status: 429 })
    await expect(refundRateLimit(event, "tutor", policy)).resolves.toEqual([undefined, { status: "refunded" }])
    await expect(requireRateLimit(event, "tutor", policy)).resolves.toBeUndefined()
    await expect(refundRateLimit(event, "tutor", { ...policy, message: "No." } as never)).rejects.toThrow('does not support the "message" option')
    await expect(refundRateLimit(requestEvent(), "tutor", { limit: 1, window: "1d" })).resolves.toMatchObject([{ code: "RATE_LIMIT_R0013" }, undefined])
  })

  it("reports the Cloudflare binding as unsupported without calling it", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const limit = vi.fn(async () => ({ success: true }))
    const [error, result] = await refundRateLimit(cloudflareEvent("uploads", { limit }), "uploads", { key: "user", limit: 1, window: "1m" })

    expect(error).toBeUndefined()
    expect(result).toMatchObject({ status: "unsupported" })
    expect(limit).not.toHaveBeenCalled()
  })

  it("counts a window that the Cloudflare binding does not support in KV, and refunds it", async () => {
    const values = new Map<string, number>()
    const storage = {
      delete: async (key: string) => (values.delete(key), [undefined, undefined] as [undefined, undefined]),
      get: async (key: string) => [undefined, values.get(key) ?? null] as [undefined, unknown],
      increment: async (key: string) => {
        values.set(key, (values.get(key) ?? 0) + 1)
        return [undefined, values.get(key)!] as [undefined, number]
      },
    }
    const deploy = (namespace: string) => setRateLimitRuntimeConfig({ driver: "cloudflare", namespace }, { driver: async () => "upstash", storage, store: "default" })
    deploy("production")
    const limit = vi.fn(async () => ({ success: true }))
    const event = cloudflareEvent("tutor", { limit }, { "cf-connecting-ip": "198.51.100.7" })
    const policy = { limit: 1, window: "1d" } as const

    await expect(checkRateLimit(event, "tutor", policy)).resolves.toMatchObject([undefined, { allowed: true, remaining: 0 }])
    await expect(checkRateLimit(event, "tutor", policy)).resolves.toMatchObject([undefined, { allowed: false, reason: "limited" }])
    await expect(refundRateLimit(event, "tutor", policy)).resolves.toEqual([undefined, { status: "refunded" }])
    await expect(peekRateLimit("tutor", "198.51.100.7")).resolves.toMatchObject({ counters: [{ used: 1 }], provider: "cloudflare", scope: "global", status: "known" })
    deploy("staging")
    await expect(checkRateLimit(event, "tutor", policy)).resolves.toMatchObject([undefined, { allowed: true, remaining: 0 }])
    await expect(refundRateLimit(event, "tutor", policy)).resolves.toEqual([undefined, { status: "refunded" }])
    await resetRateLimit("tutor", "198.51.100.7")
    deploy("production")
    await expect(checkRateLimit(event, "tutor", policy)).resolves.toMatchObject([undefined, { allowed: false, reason: "limited" }])
    expect(limit).not.toHaveBeenCalled()
  })
})

describe("non-throwing Rate Limit check", () => {
  it("consumes a token and returns the decision as a Result", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const event = requestEvent("192.0.2.30")
    const policy = { limit: 2, window: "1m" } as const

    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject([undefined, { allowed: true, limit: 2, remaining: 1 }])
    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject([undefined, { allowed: true, remaining: 0 }])
    await expect(checkRateLimit(event, "previews", policy)).resolves.toMatchObject([undefined, {
      allowed: false,
      reason: "limited",
      retryAfter: 30,
    }])
  })

  it("returns a missing Cloudflare binding as an error", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const [error, decision] = await checkRateLimit(cloudflareEvent("other-binding", { limit: async () => ({ success: true }) }), "missing-binding", { key: "user", limit: 1, window: "1m" })
    expect(decision).toBeUndefined()
    expect(error).toMatchObject({ code: "RATE_LIMIT_R0009", name: "RATE_LIMIT_R0009" })
  })

  it("shares counters with requireRateLimit() and peekRateLimit()", async () => {
    const event = requestEvent("192.0.2.31")
    const policy = { key: "user", limit: 2, window: "1m" } as const

    await checkRateLimit(event, "shared", policy)
    await requireRateLimit(event, "shared", policy)
    await expect(peekRateLimit("shared", "user")).resolves.toMatchObject({ counters: [{ used: 2 }] })
    await expect(requireRateLimit(event, "shared", policy)).rejects.toMatchObject({ status: 429 })
    await expect(checkRateLimit(event, "shared", policy)).resolves.toMatchObject([undefined, { allowed: false, reason: "limited" }])
  })

  it("reports provider unavailability as a decision", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const cause = new Error("provider unavailable")
    const event = cloudflareEvent("unavailable-previews", { limit: async () => { throw cause } })

    const [error, closed] = await checkRateLimit(event, "unavailable-previews", { failure: "deny", key: "user", limit: 1, window: "1m" })
    expect(error).toBeUndefined()
    expect(closed).toMatchObject({ allowed: false, reason: "unavailable" })
    expect(closed?.cause).toBeDefined()
    await expect(checkRateLimit(event, "unavailable-previews", { failure: "allow", key: "user", limit: 1, window: "1m" }))
      .resolves.toMatchObject([undefined, { allowed: true, reason: "unavailable" }])
  })

  it("still throws for invalid options", async () => {
    const event = requestEvent("192.0.2.32")
    await expect(checkRateLimit(event, "", { limit: 1, window: "1m" })).rejects.toThrow("`checkRateLimit()` requires a non-empty stable ID")
    await expect(checkRateLimit(event, "previews", { limit: 1, window: "1m", extra: true } as never)).rejects.toThrow("does not support")
    await expect(checkRateLimit(event, "previews", { limit: 1, message: "Slow down.", window: "1m" } as never)).rejects.toThrow('does not support the "message" option')
  })
})

describe("Rate Limit refusals on the request's wide event", () => {
  function withEvlog(event: H3Event) {
    const log = { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
    Object.assign(event.req, { context: { log } })
    return log
  }

  it("names the policy of a refused request, without the key", async () => {
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    const event = requestEvent("192.0.2.40")
    const log = withEvlog(event)
    const policy = { key: "user-123", limit: 1, window: "1m" } as const

    await requireRateLimit(event, "image-upload", policy)
    expect(log.set).not.toHaveBeenCalled()
    await expect(requireRateLimit(event, "image-upload", policy)).rejects.toMatchObject({ status: 429 })

    expect(log.set).toHaveBeenCalledOnce()
    expect(log.set.mock.calls[0]![0]).toEqual({ rateLimit: [{
      name: "image-upload",
      limit: 1,
      window: "1m",
      driver: "memory",
      keySource: "option",
      allowed: false,
      reason: "limited",
      retryAfter: 30,
    }] })
    expect(JSON.stringify(log.set.mock.calls)).not.toContain("user-123")
  })

  it("says that the key is the client address, without the address", async () => {
    const event = requestEvent("192.0.2.41")
    const log = withEvlog(event)

    await checkRateLimit(event, "previews", { limit: 1, window: "10s" })
    await checkRateLimit(event, "previews", { limit: 1, window: "10s" })

    expect(log.set.mock.calls[0]![0]).toMatchObject({ rateLimit: [{ name: "previews", keySource: "client-address", allowed: false, reason: "limited" }] })
    expect(JSON.stringify(log.set.mock.calls)).not.toContain("192.0.2.41")
  })

  it("records an unavailable limiter that lets the request through", async () => {
    setRateLimitRuntimeConfig({ driver: "cloudflare" })
    const event = cloudflareEvent("open-previews", { limit: async () => { throw new Error("provider unavailable") } })
    const log = withEvlog(event)

    await checkRateLimit(event, "open-previews", { failure: "allow", key: "user", limit: 1, window: "1m" })

    expect(log.set.mock.calls[0]![0]).toEqual({ rateLimit: [{
      name: "open-previews",
      limit: 1,
      window: "1m",
      driver: "cloudflare",
      keySource: "option",
      allowed: true,
      reason: "unavailable",
    }] })
  })

  it("keeps each policy decision separate in the emitted event", async () => {
    initLogger({ redact: false, silent: true, drain: vi.fn() })
    vi.spyOn(Date, "now").mockReturnValue(30_000)
    let count = 0
    setRateLimitRuntimeConfig({ driver: "cloudflare" }, {
      driver: async () => "upstash",
      store: "default",
      storage: {
        delete: async () => [undefined, undefined],
        get: async () => [undefined, null],
        increment: async () => [undefined, ++count],
      },
    })
    const event = cloudflareEvent("previews", { limit: async () => { throw new Error("provider unavailable") } })
    const log = createRequestLogger()
    Object.assign(event.req, { context: { log } })
    const policy = { key: "private-key", limit: 1, window: "2m" } as const
    await expect(checkRateLimit(event, "uploads", policy)).resolves.toMatchObject([undefined, { allowed: true }])
    await expect(checkRateLimit(event, "uploads", policy)).resolves.toMatchObject([undefined, { allowed: false, reason: "limited" }])
    await expect(checkRateLimit(event, "previews", { failure: "allow", key: "private-key", limit: 1, window: "1m" }))
      .resolves.toMatchObject([undefined, { allowed: true, reason: "unavailable" }])

    expect(log.emit()?.rateLimit).toEqual([
      { name: "uploads", limit: 1, window: "2m", driver: "kv", keySource: "option", allowed: false, reason: "limited", retryAfter: 90 },
      { name: "previews", limit: 1, window: "1m", driver: "cloudflare", keySource: "option", allowed: true, reason: "unavailable" },
    ])
  })

  it("refuses as before without evlog", async () => {
    const event = requestEvent("192.0.2.42")
    await requireRateLimit(event, "plain", { limit: 1, window: "1m" })
    await expect(requireRateLimit(event, "plain", { limit: 1, window: "1m" })).rejects.toMatchObject({ status: 429 })
  })
})
