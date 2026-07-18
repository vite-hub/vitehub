import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { QueueError } from "../src/errors.ts"
import { createQueueDeliveryErrorReport } from "../src/internal/delivery-error.ts"

describe("QueueError", () => {
  it("supports structured construction on the shared error foundation", () => {
    const cause = new Error("private provider detail")
    const error = new QueueError<"EXPIRY_INVALID_PAYLOAD">({
      cause,
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      httpStatus: 422,
      message: "Invalid image expiry payload.",
      method: "POST",
      provider: "vercel",
      retryable: false,
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.httpStatus).toBe(422)
    expect(error.method).toBe("POST")
    expect(error.provider).toBe("vercel")
    expect(error.toJSON()).toEqual({
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      message: "Invalid image expiry payload.",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toMatch(/httpStatus|method|private provider detail|provider/)
  })

  it("supports message-first construction without serializing compatibility metadata", () => {
    const cause = new Error("private provider detail")
    const error = new QueueError("Invalid image expiry payload.", {
      cause,
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      httpStatus: 422,
      method: "POST",
      provider: "vercel",
      retryable: false,
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.httpStatus).toBe(422)
    expect(error.method).toBe("POST")
    expect(error.provider).toBe("vercel")
    expect(error.toJSON()).toEqual({
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      message: "Invalid image expiry payload.",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toMatch(/httpStatus|method|private provider detail|provider/)
  })

  it("publishes built-in provider failures through allowlisted details", () => {
    const cause = new Error("Bearer secret-token failed at https://queue.example/private")
    const error = new QueueError<"QUEUE_PROVIDER_OPERATION_FAILED">({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
    })

    expect(error.toJSON()).toEqual({
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
    })
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("omits causes from Queue Delivery reports", () => {
    const error = new QueueError<"DELIVERY_FAILED">({
      cause: new Error("private provider detail"),
      code: "DELIVERY_FAILED",
      message: "Queue Delivery failed.",
    })

    const report = createQueueDeliveryErrorReport(error, {
      attempts: 2,
      id: "message-1",
      provider: "cloudflare",
      queue: "image-expiry",
    })

    expect(report).toMatchObject({
      attempts: 2,
      error: {
        code: "DELIVERY_FAILED",
        message: "Queue Delivery failed.",
        name: "QueueError",
      },
      id: "message-1",
      provider: "cloudflare",
      queue: "image-expiry",
      retryable: true,
    })
    expect(JSON.stringify(report)).not.toContain("private provider detail")
  })

  it("omits unsafe queue and message identifiers from delivery reports", () => {
    const report = createQueueDeliveryErrorReport(
      new Error("Bearer secret-token failed at https://queue.example/private"),
      {
        attempts: 1,
        id: "https://queue.example/messages/secret-token",
        provider: "vercel",
        queue: "../private/.env",
      },
    )

    expect(report).toEqual({
      attempts: 1,
      error: { message: "[vitehub] Queue Delivery failed.", name: "Error" },
      provider: "vercel",
      retryable: true,
    })
    expect(JSON.stringify(report)).not.toMatch(/secret-token|queue\.example|private|\.env/)
  })
})
