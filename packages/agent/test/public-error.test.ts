import { describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { toHttpErrorResponse } from "../src/http-error.ts"
import { agentDiagnostics } from "../src/agent-diagnostics.ts"
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

  it("tells chat users whether a host restart is retried", () => {
    expect(toAgentPublicError(new ViteHubError("HOST_RESTARTED", "private restart detail", { details: { retry: "pending" } }), "invocation")).toEqual({
      code: "HOST_RESTARTED",
      error: "The server restarted while I was working on this. I'll retry it automatically.",
    })
    expect(toAgentPublicError(new ViteHubError("HOST_RESTARTED", "private restart detail", { details: { retry: "exhausted" } }), "invocation")).toEqual({
      code: "HOST_RESTARTED",
      error: "The server restarted twice while I was working on this. Please send your message again.",
    })
  })

  it("preserves the stable authentication failure contract", () => {
    expect(toAgentPublicError(new ViteHubError("AUTHENTICATION_REQUIRED", "Authentication required."), "http")).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      error: "Authentication required.",
    })
  })

  it("normalizes AI SDK provider failures without exposing provider payloads", () => {
    expect(toAgentPublicError({
      data: { error: { code: "insufficient_quota", message: "private balance" } },
      name: "AI_APICallError",
      statusCode: 429,
    }, "http")).toEqual({
      code: "PROVIDER_QUOTA_EXHAUSTED",
      error: "AI provider quota is exhausted.",
    })
    expect(toAgentPublicError({
      lastError: { name: "AI_APICallError", statusCode: 503 },
      name: "AI_RetryError",
    }, "http")).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      error: "AI provider is temporarily unavailable. Try again later.",
    })
  })

  it("classifies a spending limit as quota only when it was reached", () => {
    const code = (message: string) => toAgentPublicError(agentDiagnostics.AGENT_R0726({ message }), "invocation").code
    expect(code("Reported subscription quota is available. Workspace spending limits are not reported by this provider probe.")).toBe("INTERNAL")
    expect(code("Provider status check failed: Codex App Server process exited with code 1")).toBe("INTERNAL")
    expect(code("Workspace spend cap reached")).toBe("PROVIDER_QUOTA_EXHAUSTED")
    expect(code("You have reached your workspace spending limit.")).toBe("PROVIDER_QUOTA_EXHAUSTED")
  })

  it("maps launch failures to a correlated provider-unavailable error", () => {
    expect(toAgentPublicError(new ViteHubError("PROVIDER_LAUNCH_FAILED", "private launch failure", {
      details: { stderr: "private stderr" },
      requestId: "provider-a1b2c3d4e5f6",
    }), "http")).toEqual({
      code: "PROVIDER_UNAVAILABLE",
      error: "I couldn't start the agent runtime. Please try again.",
      requestId: "provider-a1b2c3d4e5f6",
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
