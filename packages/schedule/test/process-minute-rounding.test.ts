import { expect, it, vi } from "vitest"

import { createProcessWakeDriver } from "../src/internal/process-wake-runtime.ts"

it.each([
  "0000-01-01T00:00:59.999Z",
  "0099-07-11T09:00:20.123Z",
  "1969-12-31T23:59:59.999Z",
  "2026-07-11T09:00:20.123Z",
])("preserves the calendar year when rounding %s to a due minute", async (timestamp) => {
  const now = new Date(timestamp)
  const wake = vi.fn(async () => {})
  const reportError = vi.fn()
  const driver = createProcessWakeDriver({ catchUpMs: 0, now: () => now }, { reportError, wake })
  try {
    await driver.reconcile([{ id: "every-minute", cron: "* * * * *" }])
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    expect(wake).toHaveBeenCalledWith({
      scheduleId: "every-minute",
      scheduledAt: new Date(timestamp.replace(/:\d{2}\.\d{3}Z$/, ":00.000Z")),
    })
    expect(reportError).not.toHaveBeenCalled()
    expect(now.toISOString()).toBe(timestamp)
  }
  finally {
    await driver.close()
  }
})
