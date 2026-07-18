import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { QueueError } from "../src/errors.ts"
import { createQueueDeliveryErrorReport } from "../src/internal/delivery-error.ts"

describe("QueueError", () => {
  it("supports structured construction on the shared error foundation", () => {
    const cause = new Error("private provider detail")
    const error = new QueueError({
      cause,
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      message: "Invalid image expiry payload.",
      retryable: false,
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "EXPIRY_INVALID_PAYLOAD",
      details: { counter: "expiry_invalid_payload" },
      message: "Invalid image expiry payload.",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain("private provider detail")
  })

  it("preserves string construction for provider errors", () => {
    const error = new QueueError("Queue provider failed.", {
      code: "QUEUE_PROVIDER_FAILED",
      httpStatus: 502,
      method: "send",
      provider: "vercel",
    })

    expect(error).toMatchObject({
      code: "QUEUE_PROVIDER_FAILED",
      httpStatus: 502,
      message: "Queue provider failed.",
      method: "send",
      provider: "vercel",
    })
  })

  it("omits causes from Queue Delivery reports", () => {
    const error = new QueueError({
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
})
