import { describe, expect, it } from "vitest"

const distEntry = new URL("../dist/index.js", import.meta.url)
const { QueueError } = await import(distEntry.href)

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

    const invalidResponse = new QueueError({
      code: "QUEUE_PROVIDER_RESPONSE_INVALID",
      details: { operation: "send", provider: "vercel", token: "secret-token" },
      message: "Bearer secret-token failed at https://queue.example/private",
    } as never)

    expect(invalidResponse.toJSON()).toEqual({
      code: "QUEUE_PROVIDER_RESPONSE_INVALID",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] Vercel queue provider returned an invalid send response.",
    })
    expect(JSON.stringify(invalidResponse)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("rejects invalid built-in and implicit custom contracts after packaging", () => {
    for (const input of [
      {
        code: "QUEUE_PROVIDER_OPERATION_FAILED",
        details: { operation: "cancel", provider: "vercel", token: "secret-token" },
        message: "Provider body secret-token",
      },
      {
        code: "QUEUE_PROVIDER_RESPONSE_INVALID",
        details: { operation: "send-batch", provider: "cloudflare", token: "secret-token" },
      },
      {
        code: "QUEUE_DISABLED",
        details: { provider: "vercel" },
      },
      {
        code: "IMPLICIT_CUSTOM_ERROR",
        message: "Provider body secret-token",
      },
      {
        code: "QUEUE_DISABLED",
        retryable: false,
      },
    ]) {
      expect(() => new QueueError(input as never)).toThrow("[vitehub] Invalid Queue error options.")
    }
  })
})
