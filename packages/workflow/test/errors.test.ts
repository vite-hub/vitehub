import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { WorkflowError } from "../src/index.ts"

describe("WorkflowError", () => {
  it("serializes the public contract without exposing its cause", () => {
    const cause = new Error("provider token: secret")
    const error = new WorkflowError({
      cause,
      code: "TRANSCRIPTION_FAILED",
      details: { attempt: 2, provider: "vercel" },
      message: "Transcription failed.",
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.name).toBe("WorkflowError")
    expect(error.cause).toBe(cause)
    expect(error.code).toBe("TRANSCRIPTION_FAILED")
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "TRANSCRIPTION_FAILED",
      details: { attempt: 2, provider: "vercel" },
      message: "Transcription failed.",
    })
    expect(JSON.stringify(error)).not.toContain("secret")
  })
})
