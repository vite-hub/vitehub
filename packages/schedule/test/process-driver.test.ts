import { afterEach, describe, expect, it, vi } from "vitest"

import { installScheduleRuntime } from "../src/runtime/driver.ts"
import { createProcessScheduleWakeDriver } from "../src/runtime/process.ts"
import { resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryRuntimeScheduleStore, createMemoryScheduleRunStore } from "../src/runtime/store.ts"

import type { RuntimeScheduleRecord } from "../src/types.ts"
import type { RuntimeScheduleWakeDriver, RuntimeScheduleWakeDriverContext } from "../src/runtime/driver.ts"
import type { ProcessScheduleWakeDriverOptions } from "../src/runtime/process.ts"

function record(id: string, options: Partial<RuntimeScheduleRecord> = {}): RuntimeScheduleRecord {
  const now = new Date("2026-07-11T08:00:00.000Z")
  return {
    createdAt: now,
    cron: "* * * * *",
    enabled: true,
    id,
    target: "report",
    updatedAt: now,
    ...options,
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function createDriver(context: RuntimeScheduleWakeDriverContext, options: ProcessScheduleWakeDriverOptions = {}): Promise<RuntimeScheduleWakeDriver> {
  return await createProcessScheduleWakeDriver(options)(context)
}

afterEach(() => {
  vi.useRealTimers()
  resetScheduleRuntime()
})

describe("Process Schedule Wake Driver", () => {
  it("executes due stored schedules through the installed Runtime Schedule boundary", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-07-11T09:00:20.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    await runtimeScheduleStore.create(record("daily"))
    let calls = 0
    let handled!: () => void
    const handledSchedule = new Promise<void>(resolve => { handled = resolve })

    const controller = await installScheduleRuntime({
      createDriver: createProcessScheduleWakeDriver({ now: () => now }),
      registry: {
        report: async () => ({
          cron: "* * * * *",
          handler: async () => {
            calls += 1
            handled()
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })
    await handledSchedule
    await flushAsyncWork()

    expect(calls).toBe(1)
    expect(await scheduleRunStore.listRuns()).toEqual([
      expect.objectContaining({
        scheduleId: "daily",
        scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
        status: "succeeded",
      }),
    ])
    await controller.close()
  })

  it("wakes each enabled due schedule once per process minute", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { intervalMs: 1_000 })

    await driver.reconcile([
      record("daily"),
      record("disabled", { enabled: false }),
    ])
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(wake).toHaveBeenCalledTimes(2)
    expect(wake).toHaveBeenLastCalledWith({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:01:00.000Z"),
    })

    await driver.close?.()
  })

  it("reconciles additions and removals without polling the schedule store", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { intervalMs: 1_000 })

    await driver.reconcile([record("first")])
    await flushAsyncWork()
    await driver.reconcile([record("second")])
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(wake.mock.calls.map(([input]) => input.scheduleId)).toEqual(["first", "second", "second"])
    await driver.close?.()
  })

  it("limits concurrent wake delivery", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseFirst: (() => void) | undefined
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {
      if (!releaseFirst) await new Promise<void>(resolve => { releaseFirst = resolve })
    })
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { concurrency: 1, intervalMs: 1_000 })

    await driver.reconcile([record("first"), record("second")])
    await flushAsyncWork()
    expect(wake).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await flushAsyncWork()
    expect(wake).toHaveBeenCalledTimes(2)

    await driver.close?.()
  })

  it("drops queued wakes when reconciliation removes the schedule", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseFirst: (() => void) | undefined
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {
      if (!releaseFirst) await new Promise<void>(resolve => { releaseFirst = resolve })
    })
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { concurrency: 1, intervalMs: 1_000 })

    await driver.reconcile([record("first"), record("removed")])
    await flushAsyncWork()
    expect(wake).toHaveBeenCalledTimes(1)

    await driver.reconcile([record("first")])
    releaseFirst?.()
    await flushAsyncWork()

    expect(wake).toHaveBeenCalledTimes(1)
    await driver.close?.()
  })

  it("preserves a current-minute dispatch when pruning an older queued occurrence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:01:20.000Z"))
    let releaseFirst!: () => void
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {
      if (wake.mock.calls.length === 1) {
        await new Promise<void>(resolve => { releaseFirst = resolve })
      }
    })
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { concurrency: 1, intervalMs: 1_000 })

    await driver.reconcile([record("blocker"), record("daily")])
    await vi.advanceTimersByTimeAsync(60_000)
    await driver.reconcile([record("blocker"), record("daily", { cron: "*/2 * * * *" })])
    releaseFirst()
    await flushAsyncWork()
    await flushAsyncWork()

    const currentDailyWakes = wake.mock.calls.filter(([input]) => (
      input.scheduleId === "daily" && input.scheduledAt.getTime() === new Date("2026-07-11T09:02:00.000Z").getTime()
    ))
    expect(currentDailyWakes).toHaveLength(1)
    await driver.close?.()
  })

  it("reports wake errors and continues scanning later minutes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const error = new Error("wake failed")
    const reportError = vi.fn<RuntimeScheduleWakeDriverContext["reportError"]>()
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined)
    const driver = await createDriver({ reportError, wake }, { intervalMs: 1_000 })

    await driver.reconcile([record("daily")])
    await flushAsyncWork()
    expect(reportError).toHaveBeenCalledWith(error)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wake).toHaveBeenCalledTimes(2)

    await driver.close?.()
  })

  it("validates options and stored cron expressions before reconciliation succeeds", async () => {
    const context: RuntimeScheduleWakeDriverContext = {
      reportError: vi.fn(),
      wake: vi.fn(),
    }

    expect(() => createProcessScheduleWakeDriver({ intervalMs: 0 })(context)).toThrow("intervalMs must be a positive number")
    expect(() => createProcessScheduleWakeDriver({ intervalMs: 60_001 })(context)).toThrow("no greater than 60000")
    expect(() => createProcessScheduleWakeDriver({ concurrency: 0 })(context)).toThrow("concurrency must be a positive integer")

    const driver = await createDriver(context)
    await expect(driver.reconcile([record("invalid", { cron: "bad" })])).rejects.toThrow("five-field cron expression")
    await driver.close?.()
  })

  it("stops timers and rejects reconciliation after close", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { intervalMs: 1_000 })

    await driver.reconcile([record("daily")])
    await flushAsyncWork()
    await driver.close?.()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(wake).toHaveBeenCalledTimes(1)
    await expect(driver.reconcile([record("later")])).rejects.toThrow("is closed")
  })

  it("waits for active wakes to settle before closing", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseWake!: () => void
    const wake = vi.fn<RuntimeScheduleWakeDriverContext["wake"]>(async () => {
      await new Promise<void>(resolve => { releaseWake = resolve })
    })
    const driver = await createDriver({ reportError: vi.fn(), wake }, { intervalMs: 1_000 })
    await driver.reconcile([record("daily")])

    let closed = false
    const closePromise = Promise.resolve(driver.close?.()).then(() => { closed = true })
    await flushAsyncWork()
    expect(closed).toBe(false)

    releaseWake()
    await closePromise
    expect(closed).toBe(true)
  })
})
