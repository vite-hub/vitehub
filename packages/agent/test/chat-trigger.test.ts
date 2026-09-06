import { describe, expect, it } from "vitest"

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
})
