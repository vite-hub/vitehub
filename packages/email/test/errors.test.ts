import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { EmailError } from "../src/index.ts"

describe("EmailError", () => {
  it("supports object construction and safe shared serialization", () => {
    const cause = new Error("SMTP secret at smtp://user:password@example.com")
    const error = new EmailError({
      cause,
      code: "network",
      details: { operation: "send" },
      driver: "smtp",
      message: "[vitehub] Email delivery failed.",
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.driver).toBe("smtp")
    expect(error.toJSON()).toEqual({
      code: "network",
      details: { driver: "smtp", operation: "send" },
      message: "[vitehub] Email delivery failed.",
    })
    expect(JSON.stringify(error)).not.toMatch(/password|example\.com|cause|stack/)
  })

  it("preserves the positional constructor", () => {
    const error = new EmailError("rate-limit", "[vitehub] Email provider throttled delivery.", {
      driver: "fixture",
    })

    expect(error).toMatchObject({
      code: "rate-limit",
      driver: "fixture",
      name: "EmailError",
    })
    expect(error.toJSON()).toEqual({
      code: "rate-limit",
      details: { driver: "fixture" },
      message: "[vitehub] Email provider throttled delivery.",
    })
  })

  it("only serializes bounded opaque driver identifiers", () => {
    const secret = "https://provider.example/send?token=email-secret"
    const error = new EmailError({
      code: "provider",
      details: { driver: secret, operation: "send" },
      message: "[vitehub] Email delivery failed.",
    })

    expect(error.driver).toBeUndefined()
    expect(error.toJSON()).toEqual({
      code: "provider",
      details: { operation: "send" },
      message: "[vitehub] Email delivery failed.",
    })
    expect(JSON.stringify(error)).not.toContain("email-secret")
  })
})
