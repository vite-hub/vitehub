import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  CapabilityNotFoundError,
} from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { LlmGateRejectedError } from "../src/capabilities/llm-gate.ts"
import { RateLimitRejectedError } from "../src/capabilities/rate-limit.ts"
import { getHttpErrorStatusCode, toHttpErrorResponse } from "../src/http-error.ts"
import { toAgentPublicError } from "../src/public-error.ts"

const hostileMessages = [
  "prompt=delete every repository",
  "https://provider.example/private?token=secret",
  "provider body: {\"apiKey\":\"secret\"}",
  "command: rm -rf /workspace",
  "Error: private failure\n    at /srv/private.ts:10:2",
]

describe("Agent public errors", () => {
  it("maps owned failures to fixed messages and allowlisted details", () => {
    expect(toAgentPublicError(new RateLimitRejectedError("rate-limit", {
      retryAfter: 60,
    } as never, hostileMessages[0]), "http")).toEqual({
      code: "RATE_LIMIT_REJECTED",
      details: { capability: "rate-limit", retryAfter: 60 },
      error: "Rate limit exceeded. Try again later.",
    })

    expect(toAgentPublicError(new LlmGateRejectedError("safety-gate", {
      allowed: false,
      category: "unsafe",
      reason: hostileMessages[1],
    }, hostileMessages[2]), "invocation")).toEqual({
      code: "LLM_GATE_REJECTED",
      details: { capability: "safety-gate", category: "unsafe" },
      error: "Agent request was rejected.",
    })
  })

  it("keeps the safe runtime error contract without copying error messages", () => {
    const cases = [
      [new CapabilityNotFoundError("search"), {
        code: "CAPABILITY_NOT_FOUND",
        details: { capability: "search" },
        error: "Capability was not found.",
      }],
      [new CapabilityDeniedError("shell", { safeReason: hostileMessages[0] }), {
        code: "CAPABILITY_DENIED",
        details: { capability: "shell" },
        error: "Capability access was denied.",
      }],
      [new ApprovalRequiredError({ capability: "email", id: "approval_email_abcdefgh", state: "awaiting-approval" }), {
        code: "APPROVAL_REQUIRED",
        details: { capability: "email" },
        error: "Capability approval is required.",
        requestId: "approval_email_abcdefgh",
      }],
    ] as const

    for (const [error, expected] of cases) {
      expect(toAgentPublicError(error, "invocation")).toEqual(expected)
    }
  })

  it("never serializes hostile messages, causes, stacks, headers, or unvalidated metadata", async () => {
    for (const hostile of hostileMessages) {
      const error = new RateLimitRejectedError("unsafe capability\nsecret", {
        retryAfter: 15,
      } as never, hostile)
      Object.defineProperties(error, {
        cause: { value: new AggregateError([new Error(hostile)], hostile) },
        headers: { value: { authorization: hostile, "x-provider-body": hostile } },
        stack: { value: hostile },
      })

      const mapped = toAgentPublicError(error, "http")
      expect(mapped).toEqual({
        code: "RATE_LIMIT_REJECTED",
        error: "Rate limit exceeded. Try again later.",
      })
      expect(JSON.stringify(mapped)).not.toContain(hostile)

      const response = toHttpErrorResponse(error)!
      expect(response.status).toBe(429)
      expect(response.headers.has("authorization")).toBe(false)
      expect(response.headers.has("x-provider-body")).toBe(false)
      expect(JSON.stringify(await response.json())).not.toContain(hostile)
    }
  })

  it("uses an empty INTERNAL fallback for unowned failures", () => {
    const cause = new AggregateError(hostileMessages.map(message => new Error(message)), hostileMessages[0])

    expect(toAgentPublicError(cause, "http")).toEqual({
      code: "INTERNAL",
      error: "Agent request failed.",
    })
    expect(toAgentPublicError(cause, "invocation")).toEqual({
      code: "INTERNAL",
      error: "Agent Invocation Stream failed.",
    })
    expect(cause.errors).toHaveLength(hostileMessages.length)
  })

  it("treats hostile objects as unowned instead of executing their metadata", () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error(hostileMessages[0])
      },
      getPrototypeOf() {
        throw new Error(hostileMessages[1])
      },
    })

    expect(toAgentPublicError(hostile, "http")).toEqual({
      code: "INTERNAL",
      error: "Agent request failed.",
    })
    expect(getHttpErrorStatusCode(hostile)).toBeUndefined()
  })
})
