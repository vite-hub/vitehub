import { describe, expect, it } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"

import { AuthSessionError, AuthenticationRequiredError } from "../src/agent.ts"

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

  it("preserves an explicit cause without serializing it", () => {
    const cause = new Error("Bearer secret-token")
    const error = new AuthenticationRequiredError({
      cause,
      message: "Sign in required.",
    })

    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in required.",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })
})

describe("AuthSessionError", () => {
  it("owns a fixed safe session-resolution contract", () => {
    const cause = new Error("Bearer secret-token")
    const error = new AuthSessionError({ cause })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(AuthSessionError)
    expect(error).toMatchObject({
      cause,
      code: "AUTH_SESSION_FAILED",
      message: "[vitehub] Authentication session resolution failed.",
      name: "AuthSessionError",
      statusCode: 503,
    })
    expect(error.toJSON()).toEqual({
      code: "AUTH_SESSION_FAILED",
      message: "[vitehub] Authentication session resolution failed.",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })
})
