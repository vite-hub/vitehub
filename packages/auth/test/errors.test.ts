import { describe, expect, it } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"

import { AuthenticationRequiredError } from "../src/agent.ts"

describe("AuthenticationRequiredError", () => {
  it("preserves the existing class, message, and HTTP contract", () => {
    const error = new AuthenticationRequiredError()

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(AuthenticationRequiredError)
    expect(error).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      message: "[vitehub] Authentication required.",
      name: "AuthenticationRequiredError",
      statusCode: 401,
    })
    expect(new AuthenticationRequiredError("Sign in required.").message).toBe("Sign in required.")
  })

  it("serializes safe details without exposing its cause", () => {
    const cause = new Error("Bearer secret-token")
    const error = new AuthenticationRequiredError({
      cause,
      details: { surface: "agent-invoker" },
      message: "Sign in required.",
    })

    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      details: { surface: "agent-invoker" },
      message: "Sign in required.",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })
})
