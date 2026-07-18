import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { NotSupportedError, SandboxError } from "../src/index.ts"

describe("SandboxError", () => {
  it("keeps allowlisted details public and the cause in memory", () => {
    const cause = new Error("provider token leaked")
    const error = new SandboxError({
      cause,
      code: "SANDBOX_HANDLER_ERROR",
      details: { attempt: 2, provider: "vercel" },
      message: "Render failed.",
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "SANDBOX_HANDLER_ERROR",
      details: { provider: "vercel" },
      message: "Sandbox definition execution failed.",
    })
    expect(JSON.stringify(error)).not.toContain("provider token leaked")
  })

  it("owns unsupported operation errors", () => {
    const error = new NotSupportedError("snapshot", "vercel")

    expect(error).toBeInstanceOf(SandboxError)
    expect(error.toJSON()).toEqual({
      code: "SANDBOX_NOT_SUPPORTED",
      details: { operation: "snapshot", provider: "vercel" },
      message: "Sandbox operation is not supported by the selected provider.",
    })
  })
})
