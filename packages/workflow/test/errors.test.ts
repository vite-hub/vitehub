import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { createWorkflowError } from "../src/errors.ts"

describe("Workflow errors", () => {
  it("uses the shared ViteHub error contract", () => {
    const cause = new Error("provider token: secret")
    const error = createWorkflowError({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
      message: "Workflow provider operation failed.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("secret")
  })

  it("accepts application failures through ViteHubError", () => {
    const error = new ViteHubError("TRANSCRIPTION_FAILED", "Transcription failed.", {
      details: { attempt: 2, provider: "custom" },
    })
    expect(error.toJSON()).toEqual({
      code: "TRANSCRIPTION_FAILED",
      details: { attempt: 2, provider: "custom" },
      message: "Transcription failed.",
      name: "ViteHubError",
    })
  })
})
