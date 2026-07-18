import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { ApplicationWorkflowError, WorkflowError } from "../src/index.ts"

describe("WorkflowError", () => {
  it("derives its public message and details from a known code", () => {
    const cause = new Error("provider token: secret")
    const error = new WorkflowError({
      cause,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.name).toBe("WorkflowError")
    expect(error.cause).toBe(cause)
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
      message: "Workflow provider operation failed.",
    })
    expect(JSON.stringify(error)).not.toContain("secret")
  })

  it("keeps its trusted public shape immutable after construction", () => {
    const error = new WorkflowError({
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation: "start", provider: "vercel", status: 503 },
    })
    const secret = "https://user:token@example.com/private"

    expect(Reflect.set(error, "code", "SECRET_CODE")).toBe(false)
    expect(Reflect.set(error, "message", secret)).toBe(false)
    expect(Reflect.set(error.details!, "operation", secret)).toBe(false)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("does not publish cast-only details or messages for built-in codes", () => {
    const secret = "https://user:token@example.com/private"
    const error = new WorkflowError({
      code: "WORKFLOW_DISABLED",
      details: { token: secret, value: 1n },
      message: secret,
    } as never)

    expect(error.toJSON()).toEqual({
      code: "WORKFLOW_DISABLED",
      message: "Workflow is disabled.",
    })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("fails hostile constructor options with a fixed public error", () => {
    const secret = "https://user:token@example.com/private"
    const options = new Proxy({}, {
      get() {
        throw new Error(secret)
      },
    })

    expect(() => new WorkflowError(options as never)).toThrow("WorkflowError requires a known workflow error code.")
    expect(() => new WorkflowError(options as never)).not.toThrow(secret)
  })
})

describe("ApplicationWorkflowError", () => {
  it("publishes explicit application messages and defensively cloned JSON details", () => {
    const cause = new Error("private provider diagnostics")
    const details = {
      attempt: 2,
      provider: { name: "custom", regions: ["arn", "fra"] },
      reference: "https://user:token@example.com/private",
    }
    const error = new ApplicationWorkflowError({
      cause,
      code: "TRANSCRIPTION_FAILED",
      details,
      message: "Transcription failed for token=explicit-public-value.",
    })
    details.provider.name = "mutated"

    expect(error.name).toBe("ApplicationWorkflowError")
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "TRANSCRIPTION_FAILED",
      details: {
        attempt: 2,
        provider: { name: "custom", regions: ["arn", "fra"] },
        reference: "https://user:token@example.com/private",
      },
      message: "Transcription failed for token=explicit-public-value.",
    })
    expect(JSON.stringify(error)).not.toContain("private provider diagnostics")
  })

  it("keeps cloned application details immutable after construction", () => {
    const error = new ApplicationWorkflowError({
      code: "CUSTOM_WORKFLOW_FAILURE",
      details: { context: { operation: "start" } },
      message: "Custom workflow failure.",
    })
    const secret = "https://user:token@example.com/private"

    expect(Reflect.set(error, "message", secret)).toBe(false)
    expect(Reflect.set(error.details!.context as object, "operation", secret)).toBe(false)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it.each([
    ["BigInt", { value: 1n }],
    ["cycles", (() => {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    })()],
    ["class instances", { failedAt: new Date() }],
    ["hostile getters", Object.defineProperty({}, "token", {
      enumerable: true,
      get() {
        throw new Error("token=private")
      },
    })],
    ["accessors", Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        return 503
      },
    })],
  ])("rejects %s in application details without publishing raw diagnostics", (_, details) => {
    expect(() => new ApplicationWorkflowError({
      code: "CUSTOM_WORKFLOW_FAILURE",
      details: details as never,
      message: "Custom workflow failure.",
    })).toThrow(/^ApplicationWorkflowError details/)
    expect(() => new ApplicationWorkflowError({
      code: "CUSTOM_WORKFLOW_FAILURE",
      details: details as never,
      message: "Custom workflow failure.",
    })).not.toThrow("token=private")
  })

  it("requires a bounded non-reserved application code and message", () => {
    expect(() => new ApplicationWorkflowError({
      code: "WORKFLOW_DISABLED",
      message: "Custom message.",
    })).toThrow("non-reserved SCREAMING_SNAKE_CASE code")
    expect(() => new ApplicationWorkflowError({
      code: "custom-code",
      message: "Custom message.",
    })).toThrow("non-reserved SCREAMING_SNAKE_CASE code")
    expect(() => new ApplicationWorkflowError({
      code: "CUSTOM__CODE",
      message: "Custom message.",
    })).toThrow("non-reserved SCREAMING_SNAKE_CASE code")
    expect(() => new ApplicationWorkflowError({
      code: "CUSTOM_CODE_",
      message: "Custom message.",
    })).toThrow("non-reserved SCREAMING_SNAKE_CASE code")
    expect(() => new ApplicationWorkflowError({
      code: "CUSTOM_CODE",
      message: "x".repeat(513),
    })).toThrow("message between 1 and 512 characters")
  })
})
