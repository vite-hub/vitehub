import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { createProcessWakeDriver } from "../src/internal/process-wake-runtime.ts"
import { runScheduleFrom } from "../src/runtime/execute.ts"
import { readScheduleConsoleRecords } from "../src/runtime/console.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { resetScheduleRuntime, setScheduleRunStore } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

import type { ProcessScheduleEntry, ProcessWakeContext, ProcessWakeDriver, ProcessWakeDriverOptions } from "../src/internal/process-wake-runtime.ts"
import type { ScheduleDefinition, ScheduleRunListOptions } from "../src/types.ts"

function record(id: string, options: Partial<ProcessScheduleEntry> = {}): ProcessScheduleEntry {
  return { cron: "* * * * *", id, ...options }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function createDriver(context: ProcessWakeContext, options: ProcessWakeDriverOptions = {}): Promise<ProcessWakeDriver> {
  return createProcessWakeDriver(options, context)
}

afterEach(() => {
  vi.useRealTimers()
  resetScheduleRuntime()
})

describe("Process Schedule Runtime", () => {
  it("runs a due Static Schedule and records the run", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-07-11T09:00:20.000Z")
    const scheduleRunStore = createMemoryScheduleRunStore()
    let calls = 0
    let handled!: () => void
    const handledSchedule = new Promise<void>(resolve => { handled = resolve })

    const controller = await installProcessScheduleRuntime({
      now: () => now,
      registry: {
        daily: async () => ({
          cron: "* * * * *",
          handler: async () => {
            calls += 1
            handled()
          },
        }),
      },
      scheduleRunStore,
    })
    await handledSchedule
    await controller.close()

    expect(calls).toBe(1)
    expect(await scheduleRunStore.listRuns()).toEqual([
      expect.objectContaining({
        id: "srun_static_daily_2026-07-11T09:00:00.000Z",
        scheduleId: "daily",
        scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
        status: "succeeded",
      }),
    ])
  })

  it("evaluates a Static Schedule cron in its declared time zone", async () => {
    const handlers = { madrid: vi.fn(), utc: vi.fn() }
    // 08:00 in Madrid is 06:00Z in summer (CEST) and 07:00Z in winter (CET).
    for (const now of ["2026-07-15T06:00:00.000Z", "2026-01-15T07:00:00.000Z", "2026-07-15T08:00:00.000Z"]) {
      const scheduleRunStore = createMemoryScheduleRunStore()
      const controller = await installProcessScheduleRuntime({
        catchUpMs: 0,
        now: () => new Date(now),
        registry: {
          madrid: async () => defineSchedule({ cron: "0 8 * * *", handler: handlers.madrid, timeZone: "Europe/Madrid" }),
          utc: async () => defineSchedule({ cron: "0 8 * * *", handler: handlers.utc }),
        },
        scheduleRunStore,
      })
      await vi.waitFor(async () => expect(await scheduleRunStore.listRuns()).toEqual([expect.objectContaining({ status: "succeeded" })]))
      await controller.close()
    }

    expect(handlers.madrid.mock.calls.map(([context]) => context.scheduledAt.toISOString())).toEqual(["2026-07-15T06:00:00.000Z", "2026-01-15T07:00:00.000Z"])
    expect(handlers.utc.mock.calls.map(([context]) => context.scheduledAt.toISOString())).toEqual(["2026-07-15T08:00:00.000Z"])
  })

  it.each([60 * 60_000, 90_000, 90_000.5])("catches up a Static Schedule minute after a restart with catchUpMs=%s", async (catchUpMs) => {
    // The previous process stopped before its 15:00 scan, and this process starts at 15:01.
    const scheduleRunStore = createMemoryScheduleRunStore()
    const previous = new Date("2026-10-16T14:50:00.000Z")
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: previous, id: "srun_static_reconcile_2026-10-16T14:50:00.000Z", scheduleId: "reconcile", scheduledAt: previous, status: "succeeded", target: "reconcile", updatedAt: previous })
    const handler = vi.fn()
    const controller = await installProcessScheduleRuntime({
      catchUpMs,
      now: () => new Date("2026-10-16T15:01:20.000Z"),
      registry: {
        reconcile: async () => ({ cron: "*/10 * * * *", handler }),
      },
      scheduleRunStore,
    })

    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    }
    finally {
      await controller.close()
    }
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: new Date("2026-10-16T15:00:00.000Z") }))
  })

  it.each(["2026-10-17T15:00:00.000Z", "2026-10-16T15:00:20.000Z"])("ignores manual runs at %s when catching up after a restart", async (scheduledAt) => {
    const scheduleRunStore = createMemoryScheduleRunStore()
    const previous = new Date("2026-10-16T14:50:00.000Z")
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: previous, id: "srun_static_reconcile_2026-10-16T14:50:00.000Z", scheduleId: "reconcile", scheduledAt: previous, status: "succeeded", target: "reconcile", updatedAt: previous })
    setScheduleRunStore(scheduleRunStore)
    const handler = vi.fn()
    const registry = { reconcile: async () => defineSchedule({ cron: "*/10 * * * *", manual: true, handler }) }
    const manual = await runScheduleFrom(registry, "reconcile", { scheduledAt })
    handler.mockClear()

    const controller = await installProcessScheduleRuntime({
      now: () => new Date("2026-10-16T15:01:20.000Z"),
      registry,
      scheduleRunStore,
    })
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    }
    finally {
      await controller.close()
    }
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: new Date("2026-10-16T15:00:00.000Z") }))
    expect(await scheduleRunStore.getRun(manual.id)).toEqual(manual)
  })

  it.each([1, 101])("catches up with a legacy custom store behind %s future manual runs", async (manualCount) => {
    const backingStore = createMemoryScheduleRunStore()
    // Existing custom stores support scheduleId and limit, but ignore the new idPrefix option.
    const listRuns = vi.fn((options: ScheduleRunListOptions = {}) => backingStore.listRuns({ scheduleId: options.scheduleId, limit: options.limit }))
    const scheduleRunStore = { ...backingStore, listRuns }
    const previous = new Date("2026-10-16T14:50:00.000Z")
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: previous, id: "srun_static_reconcile_2026-10-16T14:50:00.000Z", scheduleId: "reconcile", scheduledAt: previous, status: "succeeded", target: "reconcile", updatedAt: previous })
    setScheduleRunStore(scheduleRunStore)
    const handler = vi.fn()
    const registry = { reconcile: async () => defineSchedule({ cron: "*/10 * * * *", manual: true, handler }) }
    for (let index = 0; index < manualCount; index++) {
      await runScheduleFrom(registry, "reconcile", { scheduledAt: "2026-10-17T15:00:00Z" })
    }
    handler.mockClear()

    const controller = await installProcessScheduleRuntime({
      catchUpMs: 15 * 60_000,
      now: () => new Date("2026-10-16T15:01:20.000Z"),
      registry,
      scheduleRunStore,
    })
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    }
    finally {
      await controller.close()
    }
    // The bounded fallback must not repeat the existing 14:50 occurrence.
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: new Date("2026-10-16T15:00:00.000Z") }))
    expect(listRuns.mock.calls.map(([options]) => options)).toEqual([
      // Recovery of unfinished runs reads the two occurrences of the window, 14:50 and 15:00.
      { scheduleId: "reconcile", idPrefix: "srun_static_", limit: 2 },
      { scheduleId: "reconcile", idPrefix: "srun_static_", limit: 1 },
      { scheduleId: "reconcile", limit: 100 },
    ])
  })

  it("does not catch up a Static Schedule that has no run, or minutes outside catchUpMs", async () => {
    const scheduleRunStore = createMemoryScheduleRunStore()
    const previous = new Date("2026-10-16T12:50:00.000Z")
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: previous, id: "srun_static_reconcile_2026-10-16T12:50:00.000Z", scheduleId: "reconcile", scheduledAt: previous, status: "succeeded", target: "reconcile", updatedAt: previous })
    const reconcile = vi.fn()
    const fresh = vi.fn()
    const controller = await installProcessScheduleRuntime({
      catchUpMs: 30 * 60_000,
      now: () => new Date("2026-10-16T15:01:20.000Z"),
      registry: {
        fresh: async () => ({ cron: "*/10 * * * *", handler: fresh }),
        reconcile: async () => ({ cron: "*/10 * * * *", handler: reconcile }),
      },
      scheduleRunStore,
    })

    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
    await controller.close()
    expect(reconcile.mock.calls.map(([context]) => context.scheduledAt.toISOString())).toEqual([
      "2026-10-16T14:40:00.000Z",
      "2026-10-16T14:50:00.000Z",
      "2026-10-16T15:00:00.000Z",
    ])
    expect(fresh).not.toHaveBeenCalled()
  })

  it("loads a Schedule with a build timing when it is due, not at startup", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:01:20.000Z"))
    const scheduleRunStore = createMemoryScheduleRunStore()
    const handler = vi.fn()
    const due = vi.fn(async () => ({ default: { cron: "*/5 * * * *", handler } }))
    const later = vi.fn(async () => ({ default: { cron: "0 3 * * *", handler: vi.fn() } }))
    const controller = await installProcessScheduleRuntime({
      catchUpMs: 0,
      registry: { due, later },
      scheduleRunStore,
      timings: { due: { cron: "*/5 * * * *" }, later: { cron: "0 3 * * *", timeZone: "Europe/Madrid" } },
    })

    expect(due).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
    // The Console reads the timing without loading the module.
    expect(await readScheduleConsoleRecords()).toEqual([
      expect.objectContaining({ fields: [{ label: "Cron", value: "*/5 * * * *" }, { label: "Time zone", value: "UTC" }], id: "definition:due" }),
      expect.objectContaining({ fields: [{ label: "Cron", value: "0 3 * * *" }, { label: "Time zone", value: "Europe/Madrid" }], id: "definition:later" }),
    ])
    // 09:05 and 09:10 are due.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    await controller.close()

    expect(due).toHaveBeenCalledOnce()
    expect(later).not.toHaveBeenCalled()
    expect((await scheduleRunStore.listRuns()).map(run => run.status)).toEqual(["succeeded", "succeeded"])
  })

  it("loads a timed Schedule again on its next wake after the load failed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:01:20.000Z"))
    const handler = vi.fn()
    const onError = vi.fn()
    const load = vi.fn<() => Promise<ScheduleDefinition>>()
      .mockRejectedValueOnce(new Error("module failed"))
      .mockResolvedValue({ cron: "*/5 * * * *", handler })
    const controller = await installProcessScheduleRuntime({
      catchUpMs: 0,
      onError,
      registry: { report: load },
      scheduleRunStore: createMemoryScheduleRunStore(),
      timings: { report: { cron: "*/5 * * * *" } },
    })

    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "module failed" })))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
    await controller.close()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("loads Static Schedule definitions from module default exports before named exports", async () => {
    const defaultHandler = vi.fn()
    const namedHandler = vi.fn()
    const controller = await installProcessScheduleRuntime({
      now: () => new Date("2026-07-11T09:00:20.000Z"),
      registry: {
        "daily-report": async () => ({
          default: { cron: "0 9 * * *", handler: defaultHandler },
          handler: namedHandler,
        }) as unknown as ScheduleDefinition,
      },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await vi.waitFor(() => expect(defaultHandler).toHaveBeenCalledOnce())
    await controller.close()
    expect(namedHandler).not.toHaveBeenCalled()
  })

  it("runs static definitions with cross-realm handlers", async () => {
    const calls: string[] = []
    const handler = runInNewContext('() => calls.push("cross-realm")', { calls }) as () => void
    const controller = await installProcessScheduleRuntime({
      now: () => new Date("2026-07-11T09:00:20.000Z"),
      registry: { report: async () => ({ cron: "0 9 * * *", handler }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await vi.waitFor(() => expect(calls).toEqual(["cross-realm"]))
    await controller.close()
  })

  it("skips Static Schedule definitions with an inherited cron property", async () => {
    const inherited = { cron: "* * * * *" }
    const handler = vi.fn()
    const definition = Object.assign(Object.create(inherited), { handler })
    const scheduleRunStore = createMemoryScheduleRunStore()
    const controller = await installProcessScheduleRuntime({
      now: () => new Date("2026-07-11T09:00:20.000Z"),
      registry: { "inherited-cron": async () => definition },
      scheduleRunStore,
    })

    await flushAsyncWork()
    await controller.close()
    expect(handler).not.toHaveBeenCalled()
    expect(await scheduleRunStore.listRuns()).toEqual([])
  })

  it("rejects invalid options and restores runtime state", async () => {
    await expect(installProcessScheduleRuntime({ intervalMs: 0, registry: {}, scheduleRunStore: createMemoryScheduleRunStore() })).rejects.toThrow("intervalMs must be a positive number")
    await expect(installProcessScheduleRuntime({
      registry: { invalid: async () => ({ cron: "bad", handler: () => {} }) },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })).rejects.toThrow("five-field cron expression")
  })
})

describe("Process Schedule Wake Driver", () => {
  it("starts a due wake before reconciliation can be closed", async () => {
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { now: () => new Date("2026-07-11T09:00:20.000Z") })

    await driver.reconcile([record("daily")])
    await driver.close()

    expect(wake).toHaveBeenCalledOnce()
  })

  it("wakes each due schedule once per process minute", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { intervalMs: 1_000 })

    await driver.reconcile([
      record("daily"),
      record("hourly", { cron: "30 * * * *" }),
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

    await driver.close()
  })

  it("reconciles additions and removals without polling the schedule store", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {})
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
    await driver.close()
  })

  it("limits concurrent wake delivery", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseFirst: (() => void) | undefined
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
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

    await driver.close()
  })

  it.each([1, 2])("bounds queued work by the catch-up window (minutes waiting: %s)", async (minutesWaiting) => {
    vi.useFakeTimers({ now: new Date("2026-07-11T09:00:20.000Z") })
    let releaseFirst!: () => void
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
      if (wake.mock.calls.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
    })
    const driver = await createDriver({ reportError: vi.fn(), wake }, { catchUpMs: 60_000, concurrency: 1, intervalMs: 1_000 })
    await driver.reconcile([record("blocker", { cron: "0 9 * * *" }), record("target", { cron: "0 9 * * *" })])
    await vi.advanceTimersByTimeAsync(minutesWaiting * 60_000)
    releaseFirst()
    await flushAsyncWork()
    expect(wake).toHaveBeenCalledTimes(minutesWaiting === 1 ? 2 : 1)
    await driver.close()
  })

  it("drops queued wakes when reconciliation removes the schedule", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseFirst: (() => void) | undefined
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
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
    await driver.close()
  })

  it("preserves a current-minute dispatch when pruning an older queued occurrence", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:01:20.000Z"))
    let releaseFirst!: () => void
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
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
    await driver.close()
  })

  it("reports wake errors and continues scanning later minutes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const error = new Error("wake failed")
    const reportError = vi.fn<ProcessWakeContext["reportError"]>()
    const wake = vi.fn<ProcessWakeContext["wake"]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined)
    const driver = await createDriver({ reportError, wake }, { intervalMs: 1_000 })

    await driver.reconcile([record("daily")])
    await flushAsyncWork()
    expect(reportError).toHaveBeenCalledWith(error)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wake).toHaveBeenCalledTimes(2)

    await driver.close()
  })

  it("reports synchronous wake errors and continues scanning later minutes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const error = new Error("wake failed synchronously")
    const reportError = vi.fn<ProcessWakeContext["reportError"]>()
    const wake = vi.fn<ProcessWakeContext["wake"]>()
      .mockImplementationOnce(() => { throw error })
      .mockResolvedValue(undefined)
    const driver = await createDriver({ reportError, wake }, { intervalMs: 1_000 })

    await expect(driver.reconcile([record("daily")])).resolves.toBeUndefined()
    await flushAsyncWork()
    expect(reportError).toHaveBeenCalledWith(error)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(wake).toHaveBeenCalledTimes(2)

    await driver.close()
  })

  it("validates options and cron expressions before reconciliation succeeds", async () => {
    const context: ProcessWakeContext = {
      reportError: vi.fn(),
      wake: vi.fn(),
    }

    expect(() => createProcessWakeDriver({ intervalMs: 0 }, context)).toThrow("intervalMs must be a positive number")
    expect(() => createProcessWakeDriver({ intervalMs: 60_001 }, context)).toThrow("no greater than 60000")
    expect(() => createProcessWakeDriver({ concurrency: 0 }, context)).toThrow("concurrency must be a positive integer")
    expect(() => createProcessWakeDriver({ catchUpMs: -1 }, context)).toThrow("catchUpMs must be a finite number")

    const driver = await createDriver(context)
    await expect(driver.reconcile([record("invalid", { cron: "bad" })])).rejects.toThrow("five-field cron expression")
    await driver.close()
  })

  it("stops timers and rejects reconciliation after close", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {})
    const driver = await createDriver({
      reportError: vi.fn(),
      wake,
    }, { intervalMs: 1_000 })

    await driver.reconcile([record("daily")])
    await flushAsyncWork()
    await driver.close()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(wake).toHaveBeenCalledTimes(1)
    await expect(driver.reconcile([record("later")])).rejects.toThrow("is closed")
  })

  it("does not keep the host process alive solely for polling", async () => {
    const probe = setInterval(() => {}, 60_000)
    const timerPrototype = Object.getPrototypeOf(probe) as { unref: () => unknown }
    clearInterval(probe)
    const unref = vi.spyOn(timerPrototype, "unref")
    const driver = await createDriver({
      reportError: vi.fn(),
      wake: vi.fn(),
    })

    try {
      await driver.reconcile([])
      expect(unref).toHaveBeenCalledOnce()
    }
    finally {
      await driver.close()
      unref.mockRestore()
    }
  })

  it("waits for active wakes to settle before closing", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T09:00:20.000Z"))
    let releaseWake!: () => void
    const wake = vi.fn<ProcessWakeContext["wake"]>(async () => {
      await new Promise<void>(resolve => { releaseWake = resolve })
    })
    const driver = await createDriver({ reportError: vi.fn(), wake }, { intervalMs: 1_000 })
    await driver.reconcile([record("daily")])

    let closed = false
    const closePromise = driver.close().then(() => { closed = true })
    await flushAsyncWork()
    expect(closed).toBe(false)

    releaseWake()
    await closePromise
    expect(closed).toBe(true)
  })
})
