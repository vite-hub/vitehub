import { describe, expect, it, vi } from "vitest"

import { ViteHubError } from "@vite-hub/runtime"

import { AuthenticationProviderError, AuthenticationRequiredError } from "../src/agent.ts"

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

  it("keeps protected causes out of its public shape", () => {
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

  it("rejects hostile option accessors without invoking them", () => {
    const getter = vi.fn(() => "private-accessor-secret")
    const accessor = Object.defineProperty({}, "message", { enumerable: true, get: getter })
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("private-proxy-secret")
      },
    })

    for (const options of [accessor, hostile, null]) {
      expect(() => new AuthenticationRequiredError(options as never))
        .toThrow("[vitehub] Invalid authentication error options.")
    }
    expect(getter).not.toHaveBeenCalled()
  })
})

describe("AuthenticationProviderError", () => {
  it("owns a fixed safe provider-operation contract", () => {
    const cause = new Error("Bearer secret-token")
    const error = new AuthenticationProviderError({ cause, operation: "get-session" })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toBeInstanceOf(AuthenticationProviderError)
    expect(error).toMatchObject({
      cause,
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      message: "[vitehub] Authentication provider operation failed.",
      name: "AuthenticationProviderError",
    })
    expect(error.toJSON()).toEqual({
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      message: "[vitehub] Authentication provider operation failed.",
    })
    expect(JSON.stringify(error)).not.toContain("secret-token")
  })

  it("rejects provider operations outside the public vocabulary", () => {
    expect(() => new AuthenticationProviderError({
      operation: "Bearer secret-token at https://auth.example/private" as never,
    })).toThrow(new TypeError("[vitehub] Invalid authentication error options."))
  })

  it("rejects hostile provider options without invoking accessors", () => {
    const getter = vi.fn(() => "private-accessor-secret")
    const accessor = Object.defineProperty({}, "operation", { enumerable: true, get: getter })
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("private-proxy-secret")
      },
    })

    for (const options of [accessor, hostile, null]) {
      expect(() => new AuthenticationProviderError(options as never))
        .toThrow("[vitehub] Invalid authentication error options.")
    }
    expect(getter).not.toHaveBeenCalled()
  })
})
