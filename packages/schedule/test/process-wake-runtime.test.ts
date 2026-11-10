import { afterEach, expect, it, vi } from "vitest"

import { createProcessWakeDriver } from "../src/internal/process-wake-runtime.ts"

import type { ProcessScheduleEntry, ProcessScheduleWake, ProcessWakeContext } from "../src/internal/process-wake-runtime.ts"

function record(id = "daily"): ProcessScheduleEntry {
  return { cron: "* * * * *", id }
}

function minutes(wakes: readonly ProcessScheduleWake[]): number[] {
  return wakes.map(wake => wake.scheduledAt.getTime())
}

afterEach(() => {
  vi.useRealTimers()
})

it("scans again after each interval", async () => {
  vi.useFakeTimers({ now: 0 })
  const wakes: ProcessScheduleWake[] = []
  const driver = createProcessWakeDriver({ catchUpMs: 0 }, {
    reportError: vi.fn(),
    async wake(input) {
      wakes.push(input)
    },
  })

  await driver.reconcile([record()])
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(wakes).toEqual([
    { scheduleId: "daily", scheduledAt: new Date(0) },
    { scheduleId: "daily", scheduledAt: new Date(60_000) },
  ])
})

it("starts polling after an initial scan failure is retried", async () => {
  vi.useFakeTimers()
  const wakes: ProcessScheduleWake[] = []
  const failure = new Error("transient clock failure")
  let calls = 0
  let now = new Date(0)
  const driver = createProcessWakeDriver({
    catchUpMs: 0,
    now() {
      calls += 1
      if (calls === 2) throw failure
      return now
    },
  }, {
    reportError: vi.fn(),
    async wake(input) {
      wakes.push(input)
    },
  })

  // The original error, not a wrapper.
  await expect(driver.reconcile([record()])).rejects.toBe(failure)
  await driver.reconcile([record()])
  now = new Date(60_000)
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(minutes(wakes)).toContain(60_000)
})

it.each([
  { catchUpMs: 60 * 60_000, expected: [0, 60_000, 120_000, 180_000] },
  { catchUpMs: 90_000, expected: [0, 120_000, 180_000] },
  { catchUpMs: 90_000.5, expected: [0, 120_000, 180_000] },
  { catchUpMs: 30_000, expected: [0, 180_000] },
  { catchUpMs: 0, expected: [0, 180_000] },
])("checks due minutes within catchUpMs=$catchUpMs when a timer fires late", async ({ catchUpMs, expected }) => {
  vi.useFakeTimers()
  const wakes: ProcessScheduleWake[] = []
  let now = new Date(59_900)
  const driver = createProcessWakeDriver({ catchUpMs, now: () => now }, {
    reportError: vi.fn(),
    async wake(input) {
      wakes.push(input)
    },
  })

  await driver.reconcile([record()])
  // The next scan runs 120.2 s later. Without catch-up it would check only the 180 s minute.
  now = new Date(180_100)
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(minutes(wakes)).toEqual(expected)
})

it("does not replay a minute after the wall clock moves backward", async () => {
  vi.useFakeTimers()
  const wakes: ProcessScheduleWake[] = []
  let now = new Date(0)
  const driver = createProcessWakeDriver({ now: () => now }, {
    reportError: vi.fn(),
    async wake(input) {
      wakes.push(input)
    },
  })

  await driver.reconcile([record()])
  now = new Date(60_000)
  await vi.advanceTimersByTimeAsync(60_000)
  now = new Date(0)
  await vi.advanceTimersByTimeAsync(60_000)
  now = new Date(60_000)
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(minutes(wakes)).toEqual([0, 60_000])
})

it("reports a clock failure during a timer scan and keeps scanning", async () => {
  vi.useFakeTimers()
  const failure = new Error("clock failed")
  const wakes: ProcessScheduleWake[] = []
  let now: Date | undefined = new Date(0)
  const reportError = vi.fn<ProcessWakeContext["reportError"]>()
  const driver = createProcessWakeDriver({ catchUpMs: 0, now: () => {
    if (!now) throw failure
    return now
  } }, {
    reportError,
    async wake(input) {
      wakes.push(input)
    },
  })

  await driver.reconcile([record()])
  now = undefined
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reportError).toHaveBeenCalledWith(failure)

  now = new Date(120_000)
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(minutes(wakes)).toEqual([0, 120_000])
})

it("keeps scanning when reportError throws", async () => {
  vi.useFakeTimers({ now: 0 })
  const wake = vi.fn<ProcessWakeContext["wake"]>()
    .mockRejectedValueOnce(new Error("wake failed"))
    .mockResolvedValue(undefined)
  const reportError = vi.fn<ProcessWakeContext["reportError"]>(() => {
    throw new Error("reporter failed")
  })
  const driver = createProcessWakeDriver({ catchUpMs: 0 }, { reportError, wake })

  await driver.reconcile([record()])
  await vi.advanceTimersByTimeAsync(60_000)
  await driver.close()

  expect(reportError).toHaveBeenCalledOnce()
  expect(wake).toHaveBeenCalledTimes(2)
})

it("reports a catch-up history failure and still wakes the current minute", async () => {
  vi.useFakeTimers({ now: 120_000 })
  const failure = new Error("store offline")
  const reportError = vi.fn<ProcessWakeContext["reportError"]>()
  const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {})
  const driver = createProcessWakeDriver({}, {
    async latestScheduledAt() {
      throw failure
    },
    reportError,
    wake,
  })

  await driver.reconcile([record()])
  await driver.close()

  expect(reportError).toHaveBeenCalledWith(failure)
  expect(wake.mock.calls.map(([input]) => input.scheduledAt.getTime())).toEqual([120_000])
})

it("runs up to `concurrency` wakes at the same time", async () => {
  vi.useFakeTimers({ now: 0 })
  const releases: Array<() => void> = []
  const wake = vi.fn<ProcessWakeContext["wake"]>(() => new Promise<void>((resolve) => { releases.push(resolve) }))
  const driver = createProcessWakeDriver({ concurrency: 2 }, { reportError: vi.fn(), wake })

  await driver.reconcile([record("a"), record("b"), record("c")])
  expect(wake.mock.calls.map(([input]) => input.scheduleId)).toEqual(["a", "b"])

  releases[1]!()
  await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(3))
  expect(wake.mock.calls[2]![0].scheduleId).toBe("c")

  for (const release of releases) release()
  await driver.close()
})

it("does not start queued wakes after close begins and waits only for the running wake", async () => {
  vi.useFakeTimers({ now: 0 })
  let releaseFirst!: () => void
  const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
    if (wake.mock.calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
  })
  const driver = createProcessWakeDriver({ concurrency: 1 }, { reportError: vi.fn(), wake })

  await driver.reconcile([record("first"), record("queued")])
  expect(wake).toHaveBeenCalledOnce()

  let closed = false
  const closing = driver.close().then(() => { closed = true })
  expect(driver.close()).toBe(driver.close())
  // A reconcile during close updates the Schedules but does not wake them.
  await driver.reconcile([record("first"), record("queued"), record("added")])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(closed).toBe(false)

  releaseFirst()
  await closing
  expect(wake).toHaveBeenCalledOnce()
  await expect(driver.reconcile([record()])).rejects.toThrow("is closed")
})
