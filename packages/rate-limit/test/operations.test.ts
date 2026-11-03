import { mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"

import { requireRateLimit } from "../src/index.ts"
import { rateLimitOperations } from "../src/operations.ts"
import { setRateLimitRuntimeConfig } from "../src/runtime.ts"

const resetAt = Date.parse("2026-05-22T09:01:00.000Z")
const cloudflareReason = "The Cloudflare Rate Limiting binding exposes only limit(), which consumes a token. It cannot read or reset a counter."
const registry = createOperationRegistry([{ operations: rateLimitOperations }])

function call(name: string, input: unknown, sections: "all" | readonly string[] = "all") {
  return runOperation(registry, name, input, { access: { mode: "app", sections }, surface: "console", user: null })
}

afterEach(() => {
  vi.useRealTimers()
  setRateLimitRuntimeConfig({ provider: "memory" })
})

describe("rate-limit operations", () => {
  it("reads and resets the counters of requireRateLimit() without consuming a token", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse("2026-05-22T09:00:30.000Z"))
    setRateLimitRuntimeConfig({ provider: "memory" })
    const event = mockEvent("https://example.com/login")
    Object.assign(event.req, { ip: "192.0.2.10" })
    await requireRateLimit(event, "op-login", { limit: 5, window: "1m" })

    const peek = { key: "192.0.2.10", name: "op-login" }
    expect(await call("rate-limit.peek", peek)).toEqual({
      ok: true,
      value: {
        counters: [{ limit: 5, remaining: 4, resetAt, used: 1, window: "1m", windowMs: 60_000 }],
        key: "192.0.2.10",
        name: "op-login",
        provider: "memory",
        scope: "process",
        status: "known",
      },
    })
    expect(await call("rate-limit.peek", peek)).toMatchObject({ ok: true, value: { counters: [{ used: 1 }] } })

    expect(await call("rate-limit.reset", peek)).toEqual({ ok: true, value: { key: "192.0.2.10", name: "op-login", provider: "memory", scope: "process", status: "reset" } })
    expect(await call("rate-limit.peek", peek)).toMatchObject({ ok: true, value: { counters: [{ remaining: 5, used: 0 }] } })
  })

  it("redacts credentials in the echoed key", async () => {
    const result = await call("rate-limit.peek", { key: "Bearer sk-live-secret", name: "api" })
    expect(result).toMatchObject({ ok: true, value: { key: "Bearer [redacted]", status: "unused" } })
    expect(JSON.stringify(result)).not.toContain("sk-live-secret")
  })

  it("reports that the Cloudflare provider cannot read or reset counters", async () => {
    setRateLimitRuntimeConfig({ provider: "cloudflare" })
    for (const operation of ["rate-limit.peek", "rate-limit.reset"]) {
      expect(await call(operation, { key: "192.0.2.1", name: "login" })).toEqual({
        ok: true,
        value: { key: "192.0.2.1", name: "login", provider: "cloudflare", reason: cloudflareReason, status: "unsupported" },
      })
    }
  })

  it.each([
    { key: "", name: "login" },
    { key: "a", name: " " },
    { key: "a" },
    { name: "login" },
  ])("rejects the input %j", async input => {
    expect(await call("rate-limit.peek", input)).toMatchObject({ code: "INTERNAL_R0022", ok: false, status: 400 })
  })

  it("answers only to a call whose access includes the rate-limits section", async () => {
    const input = { key: "192.0.2.1", name: "login" }
    expect(await call("rate-limit.peek", input, ["kv"])).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    expect(await call("rate-limit.reset", input, ["rate-limits"])).toMatchObject({ ok: true })
  })

  it("marks peek as a read and reset as destructive, in the rate-limit CLI namespace", () => {
    expect(registry.list().map(operation => [operation.name, operation.kind, operation.cli?.namespace])).toEqual([
      ["rate-limit.peek", "read", "rate-limit"],
      ["rate-limit.reset", "destructive", "rate-limit"],
    ])
  })
})
