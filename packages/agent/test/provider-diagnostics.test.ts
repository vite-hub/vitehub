import { describe, expect, it, vi } from "vitest"
import { Diagnostic } from "nostics"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"

describe("provider diagnostics", () => {
  it.each([
    "Provider disconnected",
    "{malformed",
    "null",
    "false",
    "42",
    '"provider failure"',
    "[]",
    '[{"error":{"message":"nested"}}]',
    "{}",
    '{"message":"wrong level"}',
    '{"error":null}',
    '{"error":false}',
    '{"error":42}',
    '{"error":"failure"}',
    '{"error":[]}',
    '{"error":[{"message":"nested"}]}',
    '{"error":{}}',
    '{"error":{"message":null}}',
    '{"error":{"message":false}}',
    '{"error":{"message":42}}',
    '{"error":{"message":[]}}',
    '{"error":{"message":{}}}',
    '{"__proto__":{"error":{"message":"inherited"}}}',
    '{"error":{"__proto__":{"message":"inherited"}}}',
    '{"constructor":{"prototype":{"error":{"message":"inherited"}}}}',
  ])("preserves an unstructured or invalid envelope: %s", (message) => {
    expect(agentDiagnostics.AGENT_R0726({ message }).message).toBe(message)
  })

  it.each([
    [undefined, ""],
    [null, ""],
    [false, "false"],
    [0, "0"],
    ["", ""],
    [{ toString: () => "Provider disconnected" }, "Provider disconnected"],
  ])("preserves input coercion for %s", (message, expected) => {
    expect(agentDiagnostics.AGENT_R0726({ message }).message).toBe(expected)
  })

  it.each([
    ['{"error":{"message":""}}', ""],
    ['{"error":{"message":"  failure\\n"}}', "  failure\n"],
    ['{"error":{"message":"first","message":"last"}}', "last"],
    ['{"error":null,"error":{"message":"last"}}', "last"],
    ['{"error":{"message":"ignored"},"error":null}', '{"error":{"message":"ignored"},"error":null}'],
    ['{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"failure"}}', "failure"],
    ['{"__proto__":null,"constructor":{},"error":{"__proto__":{"message":"ignored"},"constructor":{},"message":"failure"}}', "failure"],
  ])("extracts a string without changing JSON key semantics: %s", (message, expected) => {
    expect(agentDiagnostics.AGENT_R0726({ message }).message).toBe(expected)
  })

  it.each([
    Object.create({ error: { message: "inherited" } }),
    { error: Object.create({ message: "inherited" }) },
    Object.assign([], { error: { message: "inherited" } }),
    { error: Object.assign([], { message: "inherited" }) },
  ])("accepts inherited fields and object-like arrays in parsed values", (payload: unknown) => {
    const parse = vi.spyOn(JSON, "parse").mockReturnValueOnce(payload)
    try {
      expect(agentDiagnostics.AGENT_R0726({ message: "{}" }).message).toBe("inherited")
    }
    finally {
      parse.mockRestore()
    }
  })

  it("reads inherited envelope accessors once", () => {
    const readMessage = vi.fn(() => "Provider disconnected")
    const providerError = Object.create(Object.defineProperty({}, "message", { get: readMessage }))
    const readError = vi.fn(() => providerError)
    const payload: unknown = Object.create(Object.defineProperty({}, "error", { get: readError }))
    const parse = vi.spyOn(JSON, "parse").mockReturnValueOnce(payload)
    try {
      expect(agentDiagnostics.AGENT_R0726({ message: "{}" }).message).toBe("Provider disconnected")
      expect(readError).toHaveBeenCalledTimes(1)
      expect(readMessage).toHaveBeenCalledTimes(1)
    }
    finally {
      parse.mockRestore()
    }
  })

  it.each([
    ["requires a newer version of Codex", "Upgrade the Codex CLI in the Agent runner and redeploy it, then start a new run."],
    ["configured model is unavailable", "Choose a configured model supported by the installed provider, or update the provider runtime, then start a new run."],
    ["spending limit exceeded", "Raise the provider workspace spending limit or wait for its billing reset, then start a new run."],
    ["rate limit reached", "Wait for the provider quota to reset, then retry. Reduce concurrent runs if this keeps happening."],
    ["invalid api key", "Sign in again or update the provider credential, then retry."],
    ["Provider disconnected", "Check the provider diagnostic details and service status before retrying."],
  ])("keeps repair guidance and diagnostic metadata for %s", (message, fix) => {
    const cause = new Error("provider failure")
    const sources = ["server/agents/support/agent.ts:12:3"]
    for (const input of [message, JSON.stringify({ error: { message } })]) {
      const error = agentDiagnostics.AGENT_R0726({ message: input, cause, sources })
      const docs = "https://vitehub.dev/docs/reference/errors-diagnostics#agent-diagnostics"
      expect(error).toBeInstanceOf(Diagnostic)
      expect(error).toMatchObject({ name: "AGENT_R0726", code: "AGENT_R0726", message, docs, fix })
      expect(error.cause).toBe(cause)
      expect(error.sources).toBe(sources)
      expect(error.toJSON()).toEqual({ name: "AGENT_R0726", why: message, docs, fix, cause, sources, stack: expect.any(String) })
      expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "AGENT_R0726", why: message, docs, fix, cause: {}, sources, stack: error.stack })
      expect(error.stack?.split("\n")[0]).toBe(`AGENT_R0726: ${message}`)
    }
  })

  it("chooses repair guidance from the original envelope", () => {
    const error = agentDiagnostics.AGENT_R0726({ message: JSON.stringify({
      details: "requires a newer version of Codex",
      error: { message: "invalid api key" },
    }) })
    expect(error.message).toBe("invalid api key")
    expect(error.fix).toBe("Upgrade the Codex CLI in the Agent runner and redeploy it, then start a new run.")
  })
})
