import { describe, expect, it } from "vitest"

import { LlmGateRejectedError } from "../src/capabilities/llm-gate.ts"
import { RateLimitRejectedError } from "../src/capabilities/rate-limit.ts"
import { toHttpErrorResponse } from "../src/http-error.ts"
import { toAgentPublicError } from "../src/agent-error.ts"

describe("Agent public error seams", () => {
  it("preserves allowed retry and category details without a capability identifier", () => {
    expect(toAgentPublicError(new RateLimitRejectedError("", {
      retryAfter: 30,
    } as never, "private limiter response"), "http")).toEqual({
      code: "RATE_LIMIT_REJECTED",
      details: { retryAfter: 30 },
      error: "Rate limit exceeded. Try again later.",
    })
    expect(toAgentPublicError(new LlmGateRejectedError("", {
      allowed: false,
      category: "unsafe",
      reason: "private model reasoning",
    }, "private classifier response"), "invocation")).toEqual({
      code: "LLM_GATE_REJECTED",
      details: { category: "unsafe" },
      error: "Agent request was rejected.",
    })
  })

  it("redacts unowned HTTP failures and hostile metadata", async () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("private proxy diagnostic")
      },
      getPrototypeOf() {
        throw new Error("private proxy diagnostic")
      },
    })
    expect(toAgentPublicError(hostile, "http")).toEqual({
      code: "INTERNAL",
      error: "Agent request failed.",
    })
    const hostileResponse = toHttpErrorResponse(hostile, 500)!
    expect(hostileResponse.status).toBe(500)
    expect(await hostileResponse.json()).toEqual({
      code: "INTERNAL",
      error: "Agent request failed.",
    })

    const secret = new Error("provider token=secret")
    Object.defineProperty(secret, "statusCode", { value: 502 })
    const response = toHttpErrorResponse(secret)!
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      code: "INTERNAL",
      error: "Agent request failed.",
    })
  })
})
