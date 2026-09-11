import { describe, expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { toAgentPublicError } from "../src/agent-error.ts"

import { resolveChatErrorFallbackText } from "../src/chat-trigger.ts"

describe("chat error fallback", () => {
  it("includes a safe provider reference without exposing diagnostics", async () => {
    // SAFETY: This fixture supplies the minimal chat failure context needed to resolve the fallback text.
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error: new Error("private stderr"),
      history: [],
      message: { text: "hello" },
      publicError: {
        code: "PROVIDER_UNAVAILABLE",
        error: "I couldn't start the agent runtime. Please try again.",
        requestId: "provider-a1b2c3d4e5f6",
      },
      run: undefined,
      thread: {},
      toolResults: [],
    } as never)

    expect(fallback).toBe("I couldn't start the agent runtime. Please try again. Reference: provider-a1b2c3d4e5f6.")
    expect(fallback).not.toContain("private stderr")
  })

  it("explains wrapped provider usage limits and reset times", async () => {
    const error = Object.assign(agentDiagnostics.AGENT_R0726({
      message: "You've hit your usage limit. Try again at Sep 15th, 2026 1:23 AM.",
    }), { usageUrl: "https://chatgpt.com/codex/settings/usage" })
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error,
      history: [], message: { text: "hello" }, publicError: toAgentPublicError(error, "invocation"),
      run: undefined, thread: {}, toolResults: [],
    } as never)

    expect(fallback).toContain("AI provider usage limit")
    expect(fallback).toContain("Sep 15th, 2026 1:23 AM.")
    expect(fallback).toContain("chatgpt.com/codex/settings/usage")
  })

  it.each([
    "Provider disconnected",
    "Too many requests",
    "The model requires a newer version of Codex",
    "Context budget exceeded",
    "Token budget exceeded",
    "Tool execution budget exceeded",
  ])("keeps unrelated wrapped provider errors private: %s", async (message) => {
    const error = agentDiagnostics.AGENT_R0726({ message })
    const publicError = toAgentPublicError(error, "invocation")
    expect(publicError.code).toBe("INTERNAL")
    expect(await resolveChatErrorFallbackText(undefined, { error, publicError } as never))
      .toBe("Sorry, I couldn't process that message.")
  })

  it.each(["Quota exhausted", "Insufficient credits", "Workspace spending limit exceeded", "Billing budget exceeded", "Spending budget is exceeded"])(
    "classifies wrapped provider quota failures: %s", (message) => {
      const error = agentDiagnostics.AGENT_R0726({ message: JSON.stringify({ error: { message } }) })
      expect(toAgentPublicError(error, "invocation").code).toBe("PROVIDER_QUOTA_EXHAUSTED")
      expect(toAgentPublicError(error, "http").code).toBe("PROVIDER_QUOTA_EXHAUSTED")
      expect(toAgentPublicError(new Error(message), "invocation").code).toBe("INTERNAL")
    },
  )

  it("keeps unrelated quota wording on the generic fallback", async () => {
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error: "Workspace storage quota exceeded",
      publicError: { code: "INTERNAL", error: "Internal error." },
    } as never)

    expect(fallback).toBe("Sorry, I couldn't process that message.")
  })

  it("does not emit links embedded only in diagnostic text", async () => {
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error: "Usage limit reached. See https://example.com/usage?secret=private",
      publicError: { code: "PROVIDER_QUOTA_EXHAUSTED", error: "AI provider quota is exhausted." },
    } as never)

    expect(fallback).toContain("AI provider usage limit")
    expect(fallback).not.toContain("https://")
    expect(fallback).not.toContain("private")
  })

  it.each(["usageUrl", "usageURL", "usageLink"])("tolerates a throwing %s getter", async (property) => {
    const error = Object.defineProperty({ message: "Usage limit reached" }, property, {
      get() { throw new Error("private getter failure") },
    })
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error,
      publicError: { code: "PROVIDER_QUOTA_EXHAUSTED", error: "AI provider quota is exhausted." },
    } as never)

    expect(fallback).toContain("AI provider usage limit")
    expect(fallback).not.toContain("private")
  })

  it("tolerates proxy traps when reading usage links", async () => {
    const error = new Proxy({ message: "Usage limit reached" }, {
      get(target, property, receiver) {
        if (["usageUrl", "usageURL", "usageLink"].includes(String(property))) {
          throw new Error("private proxy failure")
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error,
      publicError: { code: "PROVIDER_QUOTA_EXHAUSTED", error: "AI provider quota is exhausted." },
    } as never)

    expect(fallback).toContain("AI provider usage limit")
    expect(fallback).not.toContain("private")
  })

  it("keeps opaque internal errors private by default", async () => {
    const fallback = await resolveChatErrorFallbackText(undefined, {
      error: new Error("private database details"),
      history: [], message: { text: "hello" }, publicError: { code: "INTERNAL", error: "Internal error." },
      run: undefined, thread: {}, toolResults: [],
    } as never)

    expect(fallback).toBe("Sorry, I couldn't process that message.")
    expect(fallback).not.toContain("private database details")
  })

  it("lets developers choose details for any execution error", async () => {
    const fallback = await resolveChatErrorFallbackText({
      errorFallbackText: ({ error, publicError }) => `debug: ${publicError.code} ${String(error)}`,
    }, {
      error: new Error("private execution details"),
      history: [], message: { text: "hello" }, publicError: { code: "INTERNAL", error: "Internal error." },
      run: undefined, thread: {}, toolResults: [],
    } as never)

    expect(fallback).toContain("INTERNAL")
    expect(fallback).toContain("private execution details")
  })
})
