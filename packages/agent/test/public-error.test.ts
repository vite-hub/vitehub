import { describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { toHttpErrorResponse } from "../src/http-error.ts"
import { toAgentPublicError } from "../src/agent-error.ts"

describe("Agent public error seams", () => {
  it("preserves allowed retry and category details without a capability identifier", () => {
    expect(toAgentPublicError(new ViteHubError("RATE_LIMIT_REJECTED", "private limiter response", { details: { retryAfter: 30 } }), "http")).toEqual({
      code: "RATE_LIMIT_REJECTED",
      details: { retryAfter: 30 },
      error: "Rate limit exceeded. Try again later.",
    })
    expect(toAgentPublicError(new ViteHubError("LLM_GATE_REJECTED", "private classifier response", { details: { category: "unsafe" } }), "invocation")).toEqual({
      code: "LLM_GATE_REJECTED",
      details: { category: "unsafe" },
      error: "Agent request was rejected.",
    })
  })

  it("preserves the stable authentication failure contract", () => {
    expect(toAgentPublicError(new ViteHubError("AUTHENTICATION_REQUIRED", "Authentication required."), "http")).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      error: "Authentication required.",
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
