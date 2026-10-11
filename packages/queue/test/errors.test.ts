import { ViteHubError } from "@vite-hub/runtime"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"

import { createQueueError, isQueueBoundaryIdentity } from "../src/errors.ts"
import { createQueueDeliveryErrorReport } from "../src/internal/delivery-error.ts"

describe("Queue errors", () => {
  it("recognizes AbortErrors from another realm", () => {
    const abort = runInNewContext("Object.assign(new Error('caller stopped queue send'), { name: 'AbortError' })")
    expect(abort).not.toBeInstanceOf(Error)
    expect(isQueueBoundaryIdentity(abort)).toBe(true)
  })

  it("uses the shared ViteHub error contract", () => {
    const cause = new Error("private provider detail")
    const error = createQueueError("QUEUE_PROVIDER_OPERATION_FAILED", {
      cause,
      details: { operation: "send", provider: "vercel" },
    })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation: "send", provider: "vercel" },
      message: "[vitehub] vercel queue provider failed during send.",
      name: "ViteHubError",
    })
    expect(JSON.stringify(error)).not.toContain("private provider detail")
  })

  it("keeps retry policy in Queue Delivery", () => {
    const context = { attempts: 1, id: "message-1", provider: "vercel" as const, queue: "welcome" }
    const unsupported = createQueueError("VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS", {
      details: { provider: "vercel", unsupported: ["contentType"] },
    })
    const providerFailure = createQueueError("QUEUE_PROVIDER_OPERATION_FAILED", {
      details: { operation: "send", provider: "vercel" },
    })

    expect(createQueueDeliveryErrorReport(unsupported, context)).toMatchObject({
      error: { code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS", name: "ViteHubError" },
      retryable: false,
    })
    expect(createQueueDeliveryErrorReport(providerFailure, context).retryable).toBe(true)
  })

  it("reports application ViteHub errors without trusting their retry behavior", () => {
    const error = new ViteHubError("QUEUE_DISABLED", "Application queue policy rejected the message.", {
      details: { campaign: "welcome" },
    })
    const report = createQueueDeliveryErrorReport(error, {
      attempts: 1,
      id: "message-1",
      provider: "cloudflare",
      queue: "welcome",
    })

    expect(report.error).toEqual(error.toJSON())
    expect(report.retryable).toBe(true)
  })
})
