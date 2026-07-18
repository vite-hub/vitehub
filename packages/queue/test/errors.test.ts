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
      custom: true,
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

  it("publishes built-in provider failures through allowlisted details", () => {
    const cause = new Error("Bearer secret-token failed at https://queue.example/private")
    const error = new QueueError<"QUEUE_PROVIDER_OPERATION_FAILED">({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
    })

    expect(error.toJSON()).toEqual({
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
    })
    expect(error.cause).toBe(cause)
    expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("derives built-in messages and details from the runtime vocabulary", () => {
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

  it("rejects invalid runtime codes and built-in details with a fixed error", () => {
    const invalidInputs = [
      {
        code: "QUEUE_PROVIDER_OPERATION_FAILED",
        details: { operation: "cancel", provider: "vercel", token: "secret-token" },
        message: "Bearer secret-token failed at https://queue.example/private",
      },
      {
        code: "Bearer secret-token",
        details: { url: "https://queue.example/private" },
        message: "Provider body secret-token",
      },
      {
        code: "QUEUE_DISABLED",
        custom: true,
        message: "Provider body secret-token",
      },
    ]

    for (const input of invalidInputs) {
      try {
        new QueueError(input as never)
        expect.unreachable("invalid Queue error input should fail")
      }
      catch (error) {
        expect(error).toEqual(new TypeError("[vitehub] Invalid Queue error options."))
        expect(JSON.stringify(error)).not.toMatch(/secret-token|queue\.example|private/)
      }
    }
  })

  it("requires explicit runtime intent for custom application errors", () => {
    expect(() => new QueueError<"EXPIRY_FAILED">({
      code: "EXPIRY_FAILED",
      message: "Image expiry failed.",
    } as never)).toThrow("[vitehub] Invalid Queue error options.")

    expect(new QueueError<"EXPIRY_FAILED">({
      code: "EXPIRY_FAILED",
      custom: true,
      details: { operation: "delete" },
      message: "Image expiry failed.",
    }).toJSON()).toEqual({
      code: "EXPIRY_FAILED",
      details: { operation: "delete" },
      message: "Image expiry failed.",
    })
  })

  it("omits causes from Queue Delivery reports", () => {
    const error = new QueueError<"DELIVERY_FAILED">({
      cause: new Error("private provider detail"),
      code: "DELIVERY_FAILED",
      custom: true,
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

  it("does not trust forged QueueError instances in delivery reports", () => {
    const forged = Object.assign(Object.create(QueueError.prototype), {
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "cancel", provider: "vercel", token: "secret-token" },
      message: "Bearer secret-token failed at https://queue.example/private",
      retryable: false,
    })

    const report = createQueueDeliveryErrorReport(forged, {
      attempts: 1,
      id: "message-1",
      provider: "vercel",
      queue: "welcome",
    })

    expect(report).toEqual({
      attempts: 1,
      error: { message: "[vitehub] Queue Delivery failed.", name: "Error" },
      id: "message-1",
      provider: "vercel",
      queue: "welcome",
      retryable: true,
    })
    expect(JSON.stringify(report)).not.toMatch(/secret-token|queue\.example|private/)
  })

  it("snapshots custom public details before delivery reporting", () => {
    const details = { campaign: "welcome" }
    const error = new QueueError<"WELCOME_EMAIL_REJECTED">({
      code: "WELCOME_EMAIL_REJECTED",
      custom: true,
      details,
      message: "Welcome email was rejected.",
      retryable: false,
    })
    details.campaign = "secret-token"

    const report = createQueueDeliveryErrorReport(error, {
      attempts: 1,
      id: "message-1",
      provider: "cloudflare",
      queue: "welcome",
    })

    expect(report.error).toEqual({
      code: "WELCOME_EMAIL_REJECTED",
      details: { campaign: "welcome" },
      message: "Welcome email was rejected.",
      name: "QueueError",
    })
    expect(report.retryable).toBe(false)
    expect(JSON.stringify(report)).not.toContain("secret-token")
  })
})
