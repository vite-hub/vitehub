import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { throwAuthenticationProviderError } from "../src/errors.ts"

describe("Authentication errors", () => {
  it("uses the shared ViteHub error contract for provider failures", () => {
    const cause = new Error("Bearer secret-token")
    let error: unknown
    try {
      throwAuthenticationProviderError(cause, "get-session")
    }
    catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause,
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })
})
