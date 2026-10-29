import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseConsoleRateLimitPeek, peekConsoleRateLimit, resetConsoleRateLimit } from "../src/console/runtime/client/rate-limit.ts"

const calls: Array<{ input: unknown, operation: string }> = []
let answer: unknown

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)))
    return Response.json({ ok: true, value: answer })
  }))
})

afterEach(() => {
  calls.length = 0
  vi.unstubAllGlobals()
})

const known = {
  counters: [{ limit: 5, remaining: 3, resetAt: 1_780_000_000_000, used: 2, window: "1m", windowMs: 60_000 }],
  key: "192.0.2.1",
  name: "login",
  provider: "memory",
  scope: "process",
  status: "known",
}

describe("Console Rate Limit counters", () => {
  it("peeks at one key of a policy through the rate-limit.peek operation", async () => {
    answer = known
    const peek = await peekConsoleRateLimit("/app/api/_vitehub/console/rate-limit", "login", "192.0.2.1")
    expect(calls).toEqual([{ input: { key: "192.0.2.1", name: "login" }, operation: "rate-limit.peek" }])
    expect(peek).toEqual({ counters: [{ limit: 5, remaining: 3, resetAt: 1_780_000_000_000, used: 2, window: "1m" }], key: "192.0.2.1", name: "login", provider: "memory", scope: "process", status: "known" })
  })

  it("keeps the reason when no counter can be read", async () => {
    answer = { key: "k", name: "login", provider: "cloudflare", reason: "The binding cannot be read.", status: "unsupported" }
    expect(await peekConsoleRateLimit("/api/_vitehub/console/rate-limit", "login", "k")).toMatchObject({ counters: [], reason: "The binding cannot be read.", status: "unsupported" })
  })

  it("resets one key through the rate-limit.reset operation", async () => {
    answer = { key: "192.0.2.1", name: "login", provider: "memory", scope: "process", status: "reset" }
    expect(await resetConsoleRateLimit("/api/_vitehub/console/rate-limit", "login", "192.0.2.1")).toMatchObject({ status: "reset" })
    expect(calls).toEqual([{ input: { key: "192.0.2.1", name: "login" }, operation: "rate-limit.reset" }])
  })

  it.each([null, "nope", { status: "known" }, { ...known, counters: [{}] }, { ...known, status: "other" }])("rejects the invalid result %j", value => {
    expect(() => parseConsoleRateLimitPeek(value)).toThrow("invalid Rate Limit result")
  })
})
