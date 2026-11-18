import { expect, it, vi } from "vitest"

import { emitRunFailed, onRunFailed } from "../src/internal/run-failed.ts"

it("notifies other listeners when one throws synchronously", async () => {
  const error = new Error("Listener failed")
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const stopThrowing = onRunFailed(() => { throw error })
  const listener = vi.fn()
  const stopListening = onRunFailed(listener)
  const event = {
    event: "workflow.failed" as const,
    workflow: "send-digest",
    runId: "digest-1",
    error: { message: "SMTP timeout" },
    failedAt: "2026-11-18T07:00:04.120Z",
  }

  try {
    await expect(emitRunFailed(event)).resolves.toBeUndefined()
    expect(listener).toHaveBeenCalledExactlyOnceWith(event)
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(String), error)
  }
  finally {
    stopListening()
    stopThrowing()
    log.mockRestore()
  }
})
