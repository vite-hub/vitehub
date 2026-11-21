import { describe, expect, it, onTestFinished, vi } from "vitest"

import { addressKey, clientAddressKey, clientRateLimitIssue, createClientRateLimit, memoryClientRateLimit } from "../src/runtime/client-rate-limit.ts"

import type { SharedRateLimit } from "../src/runtime/client-rate-limit.ts"

const request = new Request("https://site.test/api")

describe("addressKey", () => {
  it("counts an IPv6 address as its /64 network and keeps IPv4 as it is", () => {
    expect(addressKey("2001:db8:1:2::1")).toBe(addressKey("2001:0db8:0001:0002:aaaa::5"))
    expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"))
    expect(addressKey("1.2.3.4")).toBe("1.2.3.4")
  })

  it("trusts cf-connecting-ip only on Cloudflare", () => {
    const sent = new Request("https://site.test/api", { headers: { "cf-connecting-ip": "1.1.1.1" } })
    expect(clientAddressKey(sent, { runtime: { cloudflare: {} } })).toBe("1.1.1.1")
    expect(clientAddressKey(sent, { runtime: {} })).toBe("unknown")
    expect(clientAddressKey(sent, { runtime: { clientAddress: "2.2.2.2" } })).toBe("2.2.2.2")
  })
})

it("clientRateLimitIssue accepts whole limits and durations only", () => {
  expect(clientRateLimitIssue({ limit: 5, window: "1m" })).toBeUndefined()
  expect(clientRateLimitIssue({ limit: 1, window: "1ms" })).toBeUndefined()
  expect(clientRateLimitIssue({ limit: 1, window: "100000000d" })).toBeUndefined()
  expect(clientRateLimitIssue({ limit: 0, window: "1m" })).toContain("rateLimit.limit")
  expect(clientRateLimitIssue({ limit: 1.5, window: "1m" })).toContain("rateLimit.limit")
  expect(clientRateLimitIssue({ limit: 5, window: "1 minute" })).toContain("rateLimit.window")
})

it.each(["0ms", "0s", "0m", "0h", "0d", "100000001d", `${"9".repeat(310)}d`])("rejects an ineffective or out-of-range window %s", (window) => {
  expect(clientRateLimitIssue({ limit: 1, window })).toContain("rateLimit.window")
})

it("memoryClientRateLimit opens a new window after the old one ends", () => {
  let now = 0
  const limit = memoryClientRateLimit(() => now)
  const policy = { limit: 1, window: "1s" }
  expect(limit("k", policy).allowed).toBe(true)
  expect(limit("k", policy)).toEqual({ allowed: false, retryAfter: 1 })
  now = 1000
  expect(limit("k", policy).allowed).toBe(true)
})

describe("createClientRateLimit", () => {
  it("counts in the shared Rate Limit under its name", async () => {
    const calls: unknown[] = []
    const shared: SharedRateLimit = async (_, name, options) => {
      calls.push([name, options])
      return [undefined, calls.length <= options.limit ? { allowed: true } : { allowed: false, reason: "limited", retryAfter: 30 }]
    }
    const limit = createClientRateLimit({ name: "comments", shared, unavailable: "Comments could not count this comment in Rate Limit" })
    const policy = { limit: 1, window: "1m" }
    expect(await limit(request, "guest:1.1.1.1", policy)).toEqual({ allowed: true })
    expect(await limit(request, "guest:1.1.1.1", policy)).toEqual({ allowed: false, retryAfter: 30 })
    expect(calls[0]).toEqual(["comments", { key: "guest:1.1.1.1", limit: 1, window: "1m" }])
  })

  it("counts in memory and logs when the shared Rate Limit does not answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    onTestFinished(() => error.mockRestore())
    const shared: SharedRateLimit = async () => [undefined, { allowed: false, reason: "unavailable", cause: new Error("KV down") }]
    const limit = createClientRateLimit({ name: "forms", shared, unavailable: "Forms could not count this message in Rate Limit" })
    const policy = { limit: 1, window: "1m" }
    expect((await limit(request, "k", policy)).allowed).toBe(true)
    expect((await limit(request, "k", policy)).allowed).toBe(false)
    expect(error).toHaveBeenCalledWith("[vitehub] Forms could not count this message in Rate Limit, so it counts it in the memory of this process.", new Error("KV down"))
  })
})
