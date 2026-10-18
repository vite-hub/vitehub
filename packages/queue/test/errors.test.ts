import { readFile } from "node:fs/promises"
import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { queueErrorDiagnostics } from "../src/error-diagnostics.ts"
import { isQueueError, queueProviderResult } from "../src/errors.ts"
import { createQueueDeliveryErrorReport } from "../src/internal/delivery-error.ts"

describe("Queue errors", () => {
  it("documents each Queue error code with a why, a fix, and a docs heading", async () => {
    const page = await readFile(new URL("../../../docs/content/docs/queue/limits-and-errors.md", import.meta.url), "utf8")

    for (const code of Object.keys(queueErrorDiagnostics)) {
      expect(page, code).toContain(`\n### ${code}\n`)
    }
    const error = queueErrorDiagnostics.QUEUE_DISABLED()
    expect(error.docs).toBe("https://vitehub.dev/docs/queue/limits-and-errors#queue_disabled")
    expect(error.why).not.toBe("")
    expect(error.fix).not.toBe("")
  })

  it("returns provider failures with the cause and keeps the cause out of JSON", async () => {
    const cause = new Error("private provider detail")
    const [error, data] = await queueProviderResult("vercel", "send", () => {
      throw cause
    })

    expect(data).toBeUndefined()
    expect(error).toMatchObject({ cause, code: "QUEUE_PROVIDER_FAILED", why: "The vercel queue provider failed during send." })
    expect(JSON.stringify(error)).not.toContain("private provider detail")
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "QUEUE_PROVIDER_FAILED",
      docs: "https://vitehub.dev/docs/queue/limits-and-errors#queue_provider_failed",
      fix: expect.any(String),
      name: "QUEUE_PROVIDER_FAILED",
      why: "The vercel queue provider failed during send.",
    })
  })

  it("returns an abort from the provider as a provider failure", async () => {
    const abort = new DOMException("provider timed out", "AbortError")
    const [error] = await queueProviderResult("cloudflare", "send", () => {
      throw abort
    })

    expect(error).toMatchObject({ cause: abort, code: "QUEUE_PROVIDER_FAILED" })
  })

  it("keeps retry policy in Queue Delivery", () => {
    const context = { attempts: 1, id: "message-1", provider: "vercel" as const, queue: "welcome" }
    const unsupported = queueErrorDiagnostics.QUEUE_UNSUPPORTED_OPTION({ options: "`contentType`", provider: "vercel" })
    const providerFailure = queueErrorDiagnostics.QUEUE_PROVIDER_FAILED({ operation: "send", provider: "vercel" })

    expect(createQueueDeliveryErrorReport(unsupported, context)).toMatchObject({
      error: { code: "QUEUE_UNSUPPORTED_OPTION", message: "The vercel queue provider does not support the enqueue option `contentType`.", name: "QUEUE_UNSUPPORTED_OPTION" },
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

    expect(isQueueError(error)).toBe(false)
    expect(report.error).toEqual(error.toJSON())
    expect(report.retryable).toBe(true)
  })
})
