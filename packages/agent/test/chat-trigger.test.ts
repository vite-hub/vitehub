import { describe, expect, it, vi } from "vitest"

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

  it("exposes provider quota reset times in public error details", () => {
    const error = agentDiagnostics.AGENT_R0726({ message: "You've hit your usage limit. Upgrade to Pro or try again at Sep 15th, 2026 1:23 AM." })
    const publicError = toAgentPublicError(error, "http")

    expect(publicError).toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", details: { resetText: "Sep 15th, 2026 1:23 AM" } })
    expect(publicError.details?.resetAt).toBe(new Date(2026, 8, 15, 1, 23).toISOString())
  })

  it("omits unrecognized reset wording", () => {
    const error = agentDiagnostics.AGENT_R0726({ message: "Usage limit reached. Try again at the next billing cycle." })

    expect(toAgentPublicError(error, "http").details).toBeUndefined()
    expect(toAgentPublicError(agentDiagnostics.AGENT_R0726({ message: "Quota exhausted" }), "http").details).toBeUndefined()
  })

  it.each([
    ["Sep. 15, 2026 1:23 AM", 1],
    ["Sep. 15, 2026 1:23 a.m", 1],
    ["Sep. 15, 2026 1:23 p.m", 13],
  ])("preserves dotted date abbreviations in quota reset text: %s", async (resetText, hour) => {
    const error = agentDiagnostics.AGENT_R0726({ message: `Usage limit reached. Try again at ${resetText}. Please upgrade your plan.` })
    const publicError = toAgentPublicError(error, "http")

    expect(publicError.details).toEqual({
      resetText,
      resetAt: new Date(2026, 8, 15, hour, 23).toISOString(),
    })
    expect(await resolveChatErrorFallbackText(undefined, { error, publicError } as never))
      .toBe(`The AI provider usage limit has been reached. Usage should reset ${resetText}.`)
  })

  it("preserves dotted meridiem before the reset time zone", () => {
    const error = {
      data: { error: { code: "insufficient_quota", message: "Try again at Sep. 15, 2026 1:23 p.m. UTC. Please upgrade." } },
      name: "AI_APICallError",
      statusCode: 429,
    }

    expect(toAgentPublicError(error, "http").details).toEqual({
      resetText: "Sep. 15, 2026 1:23 p.m. UTC",
      resetAt: "2026-09-15T13:23:00.000Z",
    })
  })

  it.each([
    ["-08:00", "2026-09-15T21:23:00.000Z"],
    ["-05:00", "2026-09-15T18:23:00.000Z"],
  ])("preserves %s after dotted meridiems", (zone, resetAt) => {
    const error = {
      data: { error: { code: "insufficient_quota", message: `Try again at Sep. 15, 2026 1:23 p.m. ${zone}. Please upgrade.` } },
      name: "AI_APICallError",
      statusCode: 429,
    }

    expect(toAgentPublicError(error, "http").details).toEqual({
      resetText: `Sep. 15, 2026 1:23 p.m. ${zone}`,
      resetAt,
    })
  })

  it("stops reset text before a following numeric sentence", () => {
    const error = agentDiagnostics.AGENT_R0726({ message: "Usage limit reached. Try again at Sep 15th, 2026 1:23 AM. 2 attempts remain." })

    expect(toAgentPublicError(error, "http").details?.resetText).toBe("Sep 15th, 2026 1:23 AM")
  })

  it.each([
    ["2026-09-15T01:23:00", "2026-09-15T08:23:00.000Z"],
    ["2026-09-15T01:23", "2026-09-15T08:23:00.000Z"],
    ["2026-09-15T01:23:45.123", "2026-09-15T08:23:45.123Z"],
    ["2026-09-15T01:23:45.1234", undefined],
    ["2026-09-15T01:23:45.1234Z", undefined],
    ["2026-09-15T01:23:45.1234-07:00", undefined],
    ["2026-03-08T02:30:00", undefined],
    ["2026-03-08T02:30:45.123", undefined],
    ["2026-03-08T01:30:00", "2026-03-08T09:30:00.000Z"],
    ["2026-03-08T03:30:00", "2026-03-08T10:30:00.000Z"],
    ["2026-11-01T01:30:00", undefined],
    ["2026-03-08T02:30:00Z", "2026-03-08T02:30:00.000Z"],
    ["2026-03-08T02:30:00-08:00", "2026-03-08T10:30:00.000Z"],
    ["Mar 8, 2026 2:30 AM", undefined],
    ["Mar. 8th, 2026 2:30 a.m", undefined],
    ["Mar 8, 2026 1:30 AM", "2026-03-08T09:30:00.000Z"],
    ["Mar 8, 2026 3:30 AM", "2026-03-08T10:30:00.000Z"],
    ["Nov 1, 2026 1:30 AM", undefined],
    ["Mar 8, 2026 2:30 AM UTC", "2026-03-08T02:30:00.000Z"],
    ["Mar 8, 2026 2:30 AM -0800", "2026-03-08T10:30:00.000Z"],
  ])("validates local reset times across DST transitions: %s", async (resetText, resetAt) => {
    vi.stubEnv("TZ", "America/Los_Angeles")
    try {
      const message = `Quota exhausted. Try again at ${resetText}.`
      for (const error of [
        agentDiagnostics.AGENT_R0726({ message }),
        { data: { error: { code: "insufficient_quota", message } }, name: "AI_APICallError", statusCode: 429 },
      ]) {
        for (const context of ["http", "invocation", "serialization"] as const) {
          const publicError = toAgentPublicError(error, context)
          expect(publicError.details).toEqual(resetAt ? { resetText, resetAt } : undefined)
          expect(await resolveChatErrorFallbackText(undefined, { error, publicError } as never))
            .toBe(resetAt
              ? `The AI provider usage limit has been reached. Usage should reset ${resetText}.`
              : "The AI provider usage limit has been reached. Usage will reset when the provider quota renews.")
        }
      }
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    "token sk-live-secret",
    "the next billing cycle",
    "2026-99-15T01:23:00Z",
    "2026-09-15T24:00:00",
    "2026-09-15T23:60:00",
    "2026-09-15T23:59:60",
    "2026-09-15T01:23:00.123+99:00",
    "2026-09-15T01:23:00.123private",
    "2026-02-31T01:23:00",
    "2026-09-15T24:00:00Z",
    "2026-09-15T23:60:00Z",
    "2026-09-15T23:59:60Z",
    "2026-09-15T01:23:00+14:01",
    "2026-09-15T01:23:00-14:01",
    "Sep 15, 2026 1:23 PM +15:00",
    "2026-02-31T01:23:00Z",
    "2026-04-31T01:23:00-07:00",
    "Sep 15, 2026 1:23 PM +14:99",
    "Sep 15, 2026 1:23 PM -2400",
    "Sep 15, 2026 1:99 PM",
    "Sep 15, 2026 0:23 AM",
    "Sep. 15, 2026 13:23 p.m. UTC",
    "Sep 15, 2026 12:60 AM UTC",
    "2100-02-29T01:23:00Z",
    "Feb 29, 2026 1:23 AM",
    "Feb 30, 2026 1:23 AM UTC",
    "Apr. 31st, 2026 1:23 p.m. UTC",
    "Sep 15, 0000 1:23 PM UTC",
    "Secret 15, 2026 1:23 AM",
  ])("omits private or invalid reset text: %s", async (reset) => {
    const message = `Quota exhausted. Try again at ${reset}.`
    const errors = [
      agentDiagnostics.AGENT_R0726({ message }),
      { name: "AI_APICallError", statusCode: 429, data: { error: { code: "insufficient_quota", message } } },
    ]
    for (const error of errors) {
      for (const context of ["http", "invocation", "serialization"] as const) {
        const publicError = toAgentPublicError(error, context)
        expect(publicError).toEqual({ code: "PROVIDER_QUOTA_EXHAUSTED", error: "AI provider quota is exhausted." })
        expect(await resolveChatErrorFallbackText(undefined, { error, publicError } as never))
          .toBe("The AI provider usage limit has been reached. Usage will reset when the provider quota renews.")
      }
    }
  })

  it.each([
    ["2026-09-15T01:23:00-00:00", "2026-09-15T01:23:00.000Z"],
    ["2000-02-29T01:23:00Z", "2000-02-29T01:23:00.000Z"],
    ["2028-02-29T23:23:00-07:00", "2028-03-01T06:23:00.000Z"],
    ["2026-09-15T01:23:00-14:00", "2026-09-15T15:23:00.000Z"],
    ["2026-09-15T23:59:59+14:00", "2026-09-15T09:59:59.000Z"],
    ["Feb. 29th, 2028 1:23 p.m. UTC", "2028-02-29T13:23:00.000Z"],
    ["Sep 15, 2026 1:23 PM +14:00", "2026-09-14T23:23:00.000Z"],
    ["Sep 15, 2026 12:00 AM UTC", "2026-09-15T00:00:00.000Z"],
    ["Sep. 15, 2026 12:59 p.m. UTC", "2026-09-15T12:59:00.000Z"],
  ])("preserves valid leap dates and time zones: %s", (resetText, resetAt) => {
    const message = `Quota exhausted. Try again at ${resetText}.`
    for (const error of [
      agentDiagnostics.AGENT_R0726({ message }),
      { name: "AI_APICallError", statusCode: 429, data: { error: { code: "insufficient_quota", message } } },
    ]) {
      expect(toAgentPublicError(error, "http").details).toEqual({ resetText, resetAt })
    }
  })

  it.each([
    ["MDT", "2026-09-15T19:23:00.000Z"],
    ["PDT", "2026-09-15T20:23:00.000Z"],
    ["CET", "2026-09-15T12:23:00.000Z"],
    ["CEST", "2026-09-15T11:23:00.000Z"],
    ["EET", "2026-09-15T11:23:00.000Z"],
    ["EEST", "2026-09-15T10:23:00.000Z"],
    ["JST", "2026-09-15T04:23:00.000Z"],
    ["AEST", "2026-09-15T03:23:00.000Z"],
    ["AEDT", "2026-09-15T02:23:00.000Z"],
  ])("parses named reset time zones: %s", (zone, resetAt) => {
    const resetText = `Sep 15, 2026 1:23 PM ${zone}`
    const message = `Quota exhausted. Try again at ${resetText}.`
    expect(toAgentPublicError(agentDiagnostics.AGENT_R0726({ message }), "http").details)
      .toEqual({ resetText, resetAt })
  })

  it.each(["BST", "IST", "CST", "CDT", "EST", "EDT", "MST", "PST"])("omits ambiguous reset time zones: %s", async (zone) => {
    for (const meridiem of ["PM", "p.m."]) {
      const message = `Quota exhausted. Try again at Sep 15, 2026 1:23 ${meridiem} ${zone}.`
      for (const error of [
        agentDiagnostics.AGENT_R0726({ message }),
        { name: "AI_APICallError", statusCode: 429, data: { error: { code: "insufficient_quota", message } } },
      ]) {
        for (const context of ["http", "invocation", "serialization"] as const) {
          const publicError = toAgentPublicError(error, context)
          expect(publicError.details).toBeUndefined()
          expect(await resolveChatErrorFallbackText(undefined, { error, publicError } as never))
            .toBe("The AI provider usage limit has been reached. Usage will reset when the provider quota renews.")
        }
      }
    }
  })

  it("reads reset times from AI SDK quota errors", () => {
    const error = {
      data: { error: { code: "insufficient_quota", message: "You exceeded your quota. Try again at 2026-09-15T01:23:00Z." } },
      name: "AI_APICallError",
      statusCode: 429,
    }

    expect(toAgentPublicError(error, "http").details).toEqual({ resetAt: "2026-09-15T01:23:00.000Z", resetText: "2026-09-15T01:23:00Z" })
  })

  it("preserves fractional seconds in AI SDK quota reset times", () => {
    const error = {
      data: { error: { code: "insufficient_quota", message: "You exceeded your quota. Try again at 2026-09-15T01:23:00.123Z." } },
      name: "AI_APICallError",
      statusCode: 429,
    }

    expect(toAgentPublicError(error, "http").details).toEqual({
      resetAt: "2026-09-15T01:23:00.123Z",
      resetText: "2026-09-15T01:23:00.123Z",
    })
  })

  it("passes the default fallback text to custom fallback functions", async () => {
    const error = agentDiagnostics.AGENT_R0726({ message: "You've hit your usage limit. Try again at Sep 15th, 2026 1:23 AM." })
    const publicError = toAgentPublicError(error, "invocation")
    const errorFallbackText = vi.fn(({ defaultText }: { defaultText: string }) => `${defaultText} Buy credits.`)
    const fallback = await resolveChatErrorFallbackText({ errorFallbackText }, { error, publicError } as never)

    expect(fallback).toBe("The AI provider usage limit has been reached. Usage should reset Sep 15th, 2026 1:23 AM. Buy credits.")
    await expect(resolveChatErrorFallbackText({ errorFallbackText: ({ defaultText }) => defaultText }, {
      error: new Error("private"),
      publicError: { code: "PROVIDER_UNAVAILABLE", error: "AI provider is temporarily unavailable. Try again later.", requestId: "req-1" },
    } as never)).resolves.toBe("AI provider is temporarily unavailable. Try again later. Reference: req-1.")
    await expect(resolveChatErrorFallbackText({ errorFallbackText: ({ defaultText }) => defaultText }, {
      error: new Error("private"),
      publicError: { code: "INTERNAL", error: "Internal error." },
    } as never)).resolves.toBe("Sorry, I couldn't process that message.")
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

describe("chat error Console link", () => {
  const consoleUrl = "https://agents.example.test/_vitehub/agents/support/invocations/inv-1"
  const args = (invocation?: { id: string, consoleUrl?: string }) => ({
    error: new Error("private"),
    history: [], message: { text: "hello" }, publicError: { code: "INTERNAL", error: "Internal error." },
    run: { runId: "run-1" }, thread: {}, toolResults: [],
    ...(invocation ? { invocation } : {}),
  }) as never

  it("adds the Console URL of the failed Invocation when errorConsoleLink is on", async () => {
    await expect(resolveChatErrorFallbackText({ errorConsoleLink: true }, args({ id: "inv-1", consoleUrl })))
      .resolves.toBe(`Sorry, I couldn't process that message.\n\nDetails: ${consoleUrl}`)
  })

  it("does not add the link by default", async () => {
    await expect(resolveChatErrorFallbackText({}, args({ id: "inv-1", consoleUrl })))
      .resolves.toBe("Sorry, I couldn't process that message.")
  })

  it("adds the link after custom fallback text once", async () => {
    await expect(resolveChatErrorFallbackText({ errorConsoleLink: true, errorFallbackText: "It failed." }, args({ id: "inv-1", consoleUrl })))
      .resolves.toBe(`It failed.\n\nDetails: ${consoleUrl}`)
    await expect(resolveChatErrorFallbackText({
      errorConsoleLink: true,
      errorFallbackText: ({ invocation }) => `It failed. See ${invocation?.consoleUrl}`,
    }, args({ id: "inv-1", consoleUrl }))).resolves.toBe(`It failed. See ${consoleUrl}`)
  })

  it("does not add a link when the Invocation or its URL is unknown", async () => {
    await expect(resolveChatErrorFallbackText({ errorConsoleLink: true }, args()))
      .resolves.toBe("Sorry, I couldn't process that message.")
    await expect(resolveChatErrorFallbackText({ errorConsoleLink: true }, args({ id: "inv-1" })))
      .resolves.toBe("Sorry, I couldn't process that message.")
  })

  it("does not add a link when the fallback is disabled", async () => {
    await expect(resolveChatErrorFallbackText({ errorConsoleLink: true, errorFallbackText: null }, args({ id: "inv-1", consoleUrl })))
      .resolves.toBeUndefined()
  })
})
