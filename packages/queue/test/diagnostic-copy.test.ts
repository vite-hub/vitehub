import { Diagnostic } from "nostics"
import { expect, it, vi } from "vitest"
import { loadDiagnosticCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { createCloudflareQueueBatchHandler } from "../src/providers/cloudflare.ts"

it("acks permanent errors and retries provider errors from a separately bundled Queue handler", async () => {
  const copy = await loadDiagnosticCopy(new URL("../", import.meta.url))
  const permanent = copy.create({ code: "QUEUE_DISABLED", why: "Queue is disabled", fix: "Enable Queue" })
  const transient = copy.create({ code: "QUEUE_PROVIDER_FAILED", why: "Provider unavailable" })
  expect(permanent).not.toBeInstanceOf(Diagnostic)
  const report = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    for (const [failure, action] of [[permanent, "ack"], [transient, "retry"]] as const) {
      const ack = vi.fn()
      const retry = vi.fn()
      const handler = createCloudflareQueueBatchHandler({ onMessage() { throw failure } })
      await handler({ ackAll: vi.fn(), retryAll: vi.fn(), queue: "queue--666f6f", messages: [{ ack, retry, attempts: 1, body: {}, id: "1" }] })
      expect(ack).toHaveBeenCalledTimes(action === "ack" ? 1 : 0)
      expect(retry).toHaveBeenCalledTimes(action === "retry" ? 1 : 0)
    }
    expect(report.mock.calls[0]?.[1]).toMatchObject({ error: { code: "QUEUE_DISABLED", fix: "Enable Queue" }, retryable: false })
  }
  finally {
    report.mockRestore()
  }
})
