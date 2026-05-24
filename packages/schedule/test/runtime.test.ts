import { afterEach, describe, expect, it, vi } from "vitest"

import { createKVRuntimeScheduleStore, createKVScheduleRunStore, createMemoryRuntimeScheduleStore, createMemoryScheduleRunStore, executeStaticSchedule, ScheduleError, schedules, startScheduleRunner } from "../src/index.ts"
import { loadScheduleDefinition, resetScheduleRuntime, setScheduleRunStore, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"
import type { KVStorage } from "@vitehub/kv"

function createTestKVStore(): KVStorage {
  const data = new Map<string, unknown>()

  return {
    async clear(base = "") {
      for (const key of data.keys()) {
        if (!base || key.startsWith(base)) {
          data.delete(key)
        }
      }
    },
    async del(key) {
      data.delete(key)
    },
    async get(key) {
      return (data.get(key) ?? null) as never
    },
    async has(key) {
      return data.has(key)
    },
    async keys(base = "") {
      return [...data.keys()].filter(key => key.startsWith(base)).sort()
    },
    async set(key, value) {
      data.set(key, value)
    },
    store() {
      return this
    },
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  resetScheduleRuntime()
})

describe("Runtime Schedule helper", () => {
  it("creates and reads recurring cron schedules for runtime-eligible targets", async () => {
    setScheduleRuntimeRegistry({
      "daily-report": async () => ({
        default: {
          cron: "0 9 * * *",
          handler: async () => {},
          options: { allowRuntimeSchedules: true },
        },
      }),
    })

    const created = await schedules.create({
      cron: "30 8 * * 1-5",
      id: "schedule-1",
      target: "daily-report",
    })

    expect(created).toMatchObject({
      cron: "30 8 * * 1-5",
      enabled: true,
      id: "schedule-1",
      target: "daily-report",
    })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)
    expect(await schedules.get("schedule-1")).toEqual(created)
    expect(await schedules.list()).toEqual([created])
  })

  it("updates, disables, enables, and deletes schedules through the same store", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
      cleanup: async () => ({
        cron: "0 0 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    const created = await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const updated = await schedules.update("schedule-1", { cron: "15 10 * * *", target: "cleanup" })
    expect(updated).toMatchObject({ cron: "15 10 * * *", enabled: true, id: "schedule-1", target: "cleanup" })
    expect(updated.createdAt).toEqual(created.createdAt)
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())

    expect(await schedules.disable("schedule-1")).toMatchObject({ enabled: false })
    expect(await schedules.enable("schedule-1")).toMatchObject({ enabled: true })
    expect(await schedules.delete("schedule-1")).toBe(true)
    expect(await schedules.get("schedule-1")).toBeUndefined()
  })

  it("fails clearly for duplicate runtime schedule ids", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.create({ cron: "0 10 * * *", id: "schedule-1", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_ALREADY_EXISTS",
    })
  })

  it("fails clearly for invalid cron strings", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.create({ cron: "99 9 * * *", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_CRON",
    })
  })

  it("rejects explicitly empty ids", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.create({ cron: "0 9 * * *", id: "", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ID",
    })
    await expect(schedules.create({ cron: "0 9 * * *", id: 123 as never, target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ID",
    })
  })

  it("rejects non-boolean enabled flags", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })

    await expect(schedules.create({ cron: "0 9 * * *", enabled: "false" as never, target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.update("schedule-1", { enabled: "false" as never })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_ENABLED",
    })
  })

  it("fails clearly for unknown targets", async () => {
    await expect(schedules.create({ cron: "0 9 * * *", target: "missing" })).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_FOUND",
    })
  })

  it("fails clearly for schedule targets that did not opt in", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
      }),
    })

    await expect(schedules.create({ cron: "0 9 * * *", target: "report" })).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
    })
  })

  it("preserves newer in-flight registry loads when stale loads finish", async () => {
    let finishOld: (() => void) | undefined
    let finishNew: (() => void) | undefined
    let newLoadCount = 0

    setScheduleRuntimeRegistry({
      report: async () => {
        await new Promise<void>(resolve => { finishOld = resolve })
        return { cron: "0 9 * * *", handler: async () => {} }
      },
    })
    const oldLoad = loadScheduleDefinition("report")
    await Promise.resolve()

    setScheduleRuntimeRegistry({
      report: async () => {
        newLoadCount++
        await new Promise<void>(resolve => { finishNew = resolve })
        return { cron: "0 10 * * *", handler: async () => {} }
      },
    })
    const newLoad = loadScheduleDefinition("report")
    await Promise.resolve()
    finishOld?.()
    await oldLoad

    const sharedLoad = loadScheduleDefinition("report")
    await Promise.resolve()
    finishNew?.()
    await Promise.all([newLoad, sharedLoad])

    expect(newLoadCount).toBe(1)
  })

  it("fails clearly when updating an unknown schedule", async () => {
    await expect(schedules.update("missing", { enabled: false })).rejects.toBeInstanceOf(ScheduleError)
    await expect(schedules.update("missing", { enabled: false })).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    })
  })
})

describe("KV Runtime Schedule Store", () => {
  it("matches the RuntimeScheduleStore create, list, update, get, and delete contract", async () => {
    const store = createKVRuntimeScheduleStore({ kvStore: createTestKVStore(), prefix: "tests/schedules" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const updatedAt = new Date("2026-05-23T09:01:00.000Z")

    const created = await store.create({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt,
    })

    expect(created).toEqual({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt,
    })
    expect((await store.get("schedule/1"))?.createdAt).toBeInstanceOf(Date)
    expect(await store.list()).toEqual([created])

    created.cron = "mutated"
    expect((await store.get("schedule/1"))?.cron).toBe("0 9 * * *")

    const changedAt = new Date("2026-05-23T10:00:00.000Z")
    await expect(store.update("missing", { enabled: false, updatedAt: changedAt })).resolves.toBeUndefined()
    const updated = await store.update("schedule/1", { cron: "30 10 * * *", enabled: false, updatedAt: changedAt })
    expect(updated).toMatchObject({ cron: "30 10 * * *", enabled: false, id: "schedule/1" })
    expect(updated?.createdAt).toEqual(createdAt)
    expect(updated?.updatedAt).toEqual(changedAt)

    await expect(store.create({
      createdAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "schedule/1",
      target: "daily/report",
      updatedAt,
    })).rejects.toMatchObject({ code: "SCHEDULE_ALREADY_EXISTS" })

    await expect(store.delete("missing")).resolves.toBe(false)
    await expect(store.delete("schedule/1")).resolves.toBe(true)
    await expect(store.get("schedule/1")).resolves.toBeUndefined()
  })
})

describe("Schedule Run bookkeeping", () => {
  it("records a run and one successful attempt for a Runtime Schedule", async () => {
    const seen: unknown[] = []
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async context => seen.push(context),
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const run = await schedules.run("schedule-1", { scheduledAt })
    const attempts = await schedules.listAttempts(run.id)

    expect(run).toMatchObject({
      attemptCount: 1,
      id: "srun_schedule-1_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-1",
      scheduledAt,
      status: "succeeded",
      target: "report",
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ runId: run.id, status: "succeeded" })
    expect(seen).toEqual([
      expect.objectContaining({
        attemptId: attempts[0]!.id,
        id: run.id,
        runId: run.id,
        scheduleId: "schedule-1",
        scheduledAt,
        target: "report",
      }),
    ])
  })

  it("blocks execution when a persisted Runtime Schedule target opts out", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
      }),
    })

    await expect(schedules.run("schedule-1")).rejects.toMatchObject({
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
    })
  })

  it("blocks execution when a persisted Runtime Schedule is disabled", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {},
        options: { allowRuntimeSchedules: true },
      }),
    })
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await schedules.disable("schedule-1")

    await expect(schedules.run("schedule-1")).rejects.toMatchObject({
      code: "SCHEDULE_DISABLED",
    })
  })

  it("uses the same bookkeeping path for static provider-triggered schedules", async () => {
    const scheduledAt = new Date("2026-05-23T10:00:00.000Z")
    const run = await executeStaticSchedule({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler: async () => {},
        options: { id: "static-report" },
      },
      name: "report",
      scheduledAt,
    })

    expect(run).toMatchObject({
      attemptCount: 1,
      id: "srun_static-report_2026-05-23T10:00:00.000Z",
      scheduleId: "static-report",
      scheduledAt,
      status: "succeeded",
      target: "report",
    })
    expect(await schedules.getRun(run.id)).toEqual(run)
    expect(await schedules.listAttempts(run.id)).toHaveLength(1)
  })

  it("dedupes repeated due events and does not retry or overlap by default", async () => {
    let calls = 0
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          calls += 1
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await schedules.run("schedule-1", { scheduledAt })
    const second = await schedules.run("schedule-1", { scheduledAt })

    expect(second).toEqual(first)
    expect(calls).toBe(1)
    expect(await schedules.listAttempts(first.id)).toHaveLength(1)
  })

  it("keeps run ids distinct for schedule ids with the same sanitized form", async () => {
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const first = await executeStaticSchedule({
      cron: "0 9 * * *",
      definition: { cron: "0 9 * * *", handler: async () => {}, options: { id: "daily/report" } },
      name: "daily/report",
      scheduledAt,
    })
    const second = await executeStaticSchedule({
      cron: "0 9 * * *",
      definition: { cron: "0 9 * * *", handler: async () => {}, options: { id: "daily-report" } },
      name: "daily-report",
      scheduledAt,
    })

    expect(first.id).toBe("srun_daily%2Freport_2026-05-23T09:00:00.000Z")
    expect(second.id).toBe("srun_daily-report_2026-05-23T09:00:00.000Z")
  })

  it("reloads an existing run when duplicate creation wins the race", async () => {
    const store = createMemoryScheduleRunStore()
    let calls = 0
    setScheduleRunStore({
      ...store,
      async createRun(run) {
        const created = await store.createRun(run)
        throw new Error(`Schedule Run already exists: ${created.id}`)
      },
    })
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          calls += 1
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    const run = await schedules.run("schedule-1", { scheduledAt })

    expect(run).toMatchObject({
      id: "srun_schedule-1_2026-05-23T09:00:00.000Z",
      status: "pending",
    })
    expect(calls).toBe(0)
  })

  it("records failed handler diagnostics on the run and attempt", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          throw new TypeError("boom")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    const scheduledAt = new Date("2026-05-23T09:00:00.000Z")
    await expect(schedules.run("schedule-1", { scheduledAt })).rejects.toThrow("boom")

    const [run] = await schedules.listRuns()
    expect(run).toMatchObject({
      error: { message: "boom", name: "TypeError" },
      status: "failed",
    })
    const [attempt] = await schedules.listAttempts(run!.id)
    expect(attempt).toMatchObject({
      error: { message: "boom", name: "TypeError" },
      status: "failed",
    })
  })

  it("isolates stored run errors from returned object mutation", async () => {
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "0 9 * * *",
        handler: async () => {
          throw new TypeError("boom")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })

    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })
    await expect(schedules.run("schedule-1", { scheduledAt: new Date("2026-05-23T09:00:00.000Z") })).rejects.toThrow("boom")
    const [run] = await schedules.listRuns()
    run!.error!.message = "mutated"

    expect((await schedules.getRun(run!.id))!.error).toMatchObject({ message: "boom" })
  })
})

describe("Basic Self-Hosted Schedule Runner", () => {
  it("does not let slow handlers block later scans when capacity is available", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-23T09:00:15.000Z"))

    let releaseSlow: (() => void) | undefined
    let fastCalls = 0
    setScheduleRuntimeRegistry({
      fast: async () => ({
        cron: "* * * * *",
        handler: async () => {
          fastCalls++
        },
        options: { allowRuntimeSchedules: true },
      }),
      slow: async () => ({
        cron: "* * * * *",
        handler: async () => {
          await new Promise<void>(resolve => { releaseSlow = resolve })
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-05-23T08:59:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "slow", target: "slow", updatedAt: now })

    const runner = startScheduleRunner({ concurrency: 2, intervalMs: 10, runtimeScheduleStore, scheduleRunStore })
    await flushAsyncWork()
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "fast", target: "fast", updatedAt: now })
    await vi.advanceTimersByTimeAsync(10)
    await flushAsyncWork()

    expect(fastCalls).toBe(1)
    expect((await scheduleRunStore.getRun("srun_fast_2026-05-23T09:00:00.000Z"))?.status).toBe("succeeded")

    runner.stop()
    releaseSlow?.()
    await flushAsyncWork()
  })

  it("bounds dispatched work by concurrency", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-23T09:00:00.000Z"))

    let releaseFirst: (() => void) | undefined
    let secondCalls = 0
    setScheduleRuntimeRegistry({
      first: async () => ({
        cron: "* * * * *",
        handler: async () => {
          await new Promise<void>(resolve => { releaseFirst = resolve })
        },
        options: { allowRuntimeSchedules: true },
      }),
      second: async () => ({
        cron: "* * * * *",
        handler: async () => {
          secondCalls++
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-05-23T08:59:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "first", target: "first", updatedAt: now })
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "second", target: "second", updatedAt: now })

    const runner = startScheduleRunner({ concurrency: 1, intervalMs: 10, runtimeScheduleStore, scheduleRunStore })
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(10)
    await flushAsyncWork()

    expect(secondCalls).toBe(0)
    expect(await scheduleRunStore.getRun("srun_second_2026-05-23T09:00:00.000Z")).toBeUndefined()

    releaseFirst?.()
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(10)
    await flushAsyncWork()

    expect(secondCalls).toBe(1)
    runner.stop()
  })

  it("dedupes repeated same-minute scans with deterministic Schedule Run ids", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-23T09:00:10.000Z"))

    let calls = 0
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "* * * * *",
        handler: async () => {
          calls++
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-05-23T08:59:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "report", target: "report", updatedAt: now })

    const runner = startScheduleRunner({ intervalMs: 10, runtimeScheduleStore, scheduleRunStore })
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(30)
    await flushAsyncWork()

    expect(calls).toBe(1)
    expect(await scheduleRunStore.listRuns()).toHaveLength(1)
    expect((await scheduleRunStore.listRuns())[0]?.id).toBe("srun_report_2026-05-23T09:00:00.000Z")
    runner.stop()
  })

  it("stops future scans and reports running state", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-23T09:00:00.000Z"))

    let calls = 0
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "* * * * *",
        handler: async () => {
          calls++
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-05-23T08:59:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "report", target: "report", updatedAt: now })

    const runner = startScheduleRunner({ intervalMs: 10, runtimeScheduleStore, scheduleRunStore })
    expect(runner.running).toBe(true)
    await flushAsyncWork()
    runner.stop()
    expect(runner.running).toBe(false)

    vi.setSystemTime(new Date("2026-05-23T09:01:00.000Z"))
    await vi.advanceTimersByTimeAsync(30)
    await flushAsyncWork()

    expect(calls).toBe(1)
  })

  it("records handler failures and calls onError without crashing", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-23T09:00:00.000Z"))

    const errors: unknown[] = []
    setScheduleRuntimeRegistry({
      report: async () => ({
        cron: "* * * * *",
        handler: async () => {
          throw new TypeError("runner boom")
        },
        options: { allowRuntimeSchedules: true },
      }),
    })
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-05-23T08:59:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "* * * * *", enabled: true, id: "report", target: "report", updatedAt: now })

    const runner = startScheduleRunner({ intervalMs: 10, onError: error => errors.push(error), runtimeScheduleStore, scheduleRunStore })
    await flushAsyncWork()
    await vi.advanceTimersByTimeAsync(10)
    await flushAsyncWork()

    const run = await scheduleRunStore.getRun("srun_report_2026-05-23T09:00:00.000Z")
    expect(run).toMatchObject({
      error: { message: "runner boom", name: "TypeError" },
      status: "failed",
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(TypeError)
    expect(runner.running).toBe(true)
    runner.stop()
  })
})

describe("KV Schedule Run Store", () => {
  it("matches the ScheduleRunStore run and attempt contract and round-trips dates and errors", async () => {
    const store = createKVScheduleRunStore({ kvStore: createTestKVStore(), prefix: "tests/runs" })
    const createdAt = new Date("2026-05-23T09:00:00.000Z")
    const scheduledAt = new Date("2026-05-23T09:30:00.000Z")
    const startedAt = new Date("2026-05-23T09:30:01.000Z")
    const completedAt = new Date("2026-05-23T09:30:05.000Z")
    const updatedAt = new Date("2026-05-23T09:30:06.000Z")
    const error = { message: "boom", name: "TypeError", stack: "stack" }

    const run = await store.createRun({
      attemptCount: 0,
      createdAt,
      id: "run/1",
      scheduleId: "schedule/1",
      scheduledAt,
      status: "pending",
      target: "daily/report",
      updatedAt: createdAt,
    })
    const attempt = await store.createAttempt({
      createdAt,
      id: "attempt/1",
      runId: run.id,
      startedAt,
      status: "running",
      updatedAt: createdAt,
    })

    expect(await store.getRun(run.id)).toEqual(run)
    expect(await store.getAttempt(attempt.id)).toEqual(attempt)
    expect(await store.listRuns()).toEqual([run])
    expect(await store.listAttempts(run.id)).toEqual([attempt])

    const failedRun = await store.updateRun(run.id, {
      attemptCount: 1,
      completedAt,
      error,
      startedAt,
      status: "failed",
      updatedAt,
    })
    const failedAttempt = await store.updateAttempt(attempt.id, {
      completedAt,
      error,
      status: "failed",
      updatedAt,
    })

    expect(failedRun).toMatchObject({ error, status: "failed" })
    expect(failedRun?.completedAt).toEqual(completedAt)
    expect(failedRun?.scheduledAt).toEqual(scheduledAt)
    expect(failedRun?.startedAt).toEqual(startedAt)
    expect(failedRun?.updatedAt).toEqual(updatedAt)
    expect(failedAttempt).toMatchObject({ error, status: "failed" })
    expect(failedAttempt?.completedAt).toEqual(completedAt)
    expect(failedAttempt?.startedAt).toEqual(startedAt)
    expect(failedAttempt?.updatedAt).toEqual(updatedAt)

    failedRun!.error!.message = "mutated"
    failedAttempt!.error!.message = "mutated"
    expect((await store.getRun(run.id))?.error).toMatchObject({ message: "boom" })
    expect((await store.getAttempt(attempt.id))?.error).toMatchObject({ message: "boom" })

    await expect(store.createRun(run)).rejects.toThrow("Schedule Run already exists: run/1")
    await expect(store.createAttempt(attempt)).rejects.toThrow("Schedule Run Attempt already exists: attempt/1")
    await expect(store.updateRun("missing", { status: "failed", updatedAt })).resolves.toBeUndefined()
    await expect(store.updateAttempt("missing", { status: "failed", updatedAt })).resolves.toBeUndefined()
  })
})
