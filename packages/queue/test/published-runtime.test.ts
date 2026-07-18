import { describe, expect, it } from "vitest"

import { QueueError } from "../dist/index.js"

describe("published Queue error runtime", () => {
  it("closes built-in messages and details after packaging", () => {
    const error = new QueueError({
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: {
        operation: "send",
        provider: "vercel",
        token: "secret-token",
      },
      message: "Bearer secret-token failed at https://queue.example/private",
    } as never)

    expect(error.toJSON()).toEqual({
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
    })
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("rejects invalid built-in and implicit custom contracts after packaging", () => {
    for (const input of [
      {
        code: "QUEUE_PROVIDER_OPERATION_FAILED",
        details: { operation: "cancel", provider: "vercel", token: "secret-token" },
        message: "Provider body secret-token",
      },
      {
        code: "IMPLICIT_CUSTOM_ERROR",
        message: "Provider body secret-token",
      },
    ]) {
      expect(() => new QueueError(input as never)).toThrow("[vitehub] Invalid Queue error options.")
    }
  })
})
