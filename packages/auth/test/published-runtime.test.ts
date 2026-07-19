import { describe, expect, it, vi } from "vitest"

const distEntry = new URL("../dist/agent.js", import.meta.url)
const { AuthenticationProviderError, AuthenticationRequiredError } = await import(distEntry.href)

describe("published Auth error runtime", () => {
  it("rejects hostile constructor accessors without invoking them", () => {
    const getter = vi.fn(() => "private-accessor-secret")
    const required = Object.defineProperty({}, "message", { enumerable: true, get: getter })
    const provider = Object.defineProperty({}, "operation", { enumerable: true, get: getter })
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("private-proxy-secret")
      },
    })

    expect(() => new AuthenticationRequiredError(required as never))
      .toThrow("[vitehub] Invalid authentication error options.")
    expect(() => new AuthenticationProviderError(provider as never))
      .toThrow("[vitehub] Invalid authentication error options.")
    expect(() => new AuthenticationRequiredError(hostile as never))
      .toThrow("[vitehub] Invalid authentication error options.")
    expect(() => new AuthenticationProviderError(hostile as never))
      .toThrow("[vitehub] Invalid authentication error options.")
    expect(getter).not.toHaveBeenCalled()
  })

  it("preserves exact causes behind immutable public shapes", () => {
    const cause = new Error("private-provider-secret")
    const required = new AuthenticationRequiredError({ cause, message: "Sign in required." })
    const provider = new AuthenticationProviderError({ cause, operation: "get-session" })

    expect(required.cause).toBe(cause)
    expect(provider.cause).toBe(cause)
    expect(Reflect.set(provider, "toJSON", () => ({ message: "private-provider-secret" }))).toBe(false)
    expect(JSON.stringify([required, provider])).not.toContain("private-provider-secret")
  })
})
