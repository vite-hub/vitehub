import { createMemoryLeaseStore, createSqlLeaseStore } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import { createMemoryStartedScheduleStore } from "../src/runtime/started.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

import type { LeaseStore } from "@vite-hub/runtime"
import type { ScheduleDefinitionRegistry, ScheduleRunContext, ScheduleRunStore, StartedScheduleStore } from "../src/types.ts"

/**
 * One server process: a fresh module graph, so its Schedule state is its own, as in a real process. The processes of
 * a test share only the stores that the test passes.
 */
async function startProcess() {
  vi.resetModules()
  const process = await import("../src/runtime/process.ts")
  const started = await import("../src/runtime/started.ts")
  const execute = await import("../src/runtime/execute.ts")
  return { execute, process, started }
}

type ServerProcess = Awaited<ReturnType<typeof startProcess>>

const controllers: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.close()))
  vi.useRealTimers()
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const minute = (iso: string) => new Date(iso)

function clock(start: string) {
  let current = new Date(start)
  return {
    advance(ms: number) {
      current = new Date(current.getTime() + ms)
    },
    now: () => current,
  }
}

interface InstallOptions {
  catchUpMs?: number
  leases: LeaseStore
  now: () => Date
  onError?: (error: unknown) => void
  prefix?: string
  registry: ScheduleDefinitionRegistry
  scheduleRunStore?: ScheduleRunStore
  startedStore?: StartedScheduleStore
  startedRegistry?: ScheduleDefinitionRegistry
  timings?: Record<string, { cron: string, timeZone?: string }>
}

async function install(server: ServerProcess, options: InstallOptions) {
  if (options.startedStore) {
    server.started.installStartedSchedules({ registry: options.startedRegistry ?? {}, store: options.startedStore })
  }
  const controller = await server.process.installProcessScheduleRuntime({
    catchUpMs: options.catchUpMs ?? 0,
    intervalMs: 5,
    leaseTtlMs: 200,
    leases: options.leases,
    now: options.now,
    onError: options.onError ?? (error => console.error(error)),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    registry: options.registry,
    timings: options.timings,
    scheduleRunStore: options.scheduleRunStore ?? createMemoryScheduleRunStore(),
  })
  controllers.push(controller)
  return controller
}

describe("Process Runtime on more than one process", () => {
  it("does not run a queued occurrence after its completion marker expires", async () => {
    vi.useFakeTimers({ now: minute("2026-11-09T08:00:00.000Z") })
    const leases = createMemoryLeaseStore()
    let finishSlow!: () => void
    const slow = vi.fn(() => new Promise<void>(resolve => { finishSlow = resolve }))
    const target = vi.fn()
    const registry = {
      slow: async () => defineSchedule({ cron: "0 8 * * *", handler: slow }),
      target: async () => defineSchedule({ cron: "0 8 * * *", handler: target }),
    }
    try {
      await install(await startProcess(), { leases, now: () => new Date(), registry })
      await vi.advanceTimersByTimeAsync(0)
      expect(slow).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1000)
      await install(await startProcess(), { leases, now: () => new Date(), registry })
      await vi.advanceTimersByTimeAsync(0)
      expect(target).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect((await leases.get("vitehub:schedule/schedule/srun_static_target_2026-11-09T08:00:00.000Z/done"))[1]).toBeNull()
    }
    finally {
      finishSlow?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(target).toHaveBeenCalledTimes(1)
  })

  it("isolates apps that share leases and use different prefixes", async () => {
    const leases = createMemoryLeaseStore()
    const handler = vi.fn()
    const registry = { daily: async () => defineSchedule({ cron: "* * * * *", handler }) }
    const now = () => minute("2026-11-09T08:00:10.000Z")

    await install(await startProcess(), { leases, now, prefix: "app-a:schedule", registry })
    await install(await startProcess(), { leases, now, prefix: "app-b:schedule", registry })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    expect((await leases.get("app-a:schedule/schedule/srun_static_daily_2026-11-09T08:00:00.000Z/done"))[1]).not.toBeNull()
    expect((await leases.get("app-b:schedule/schedule/srun_static_daily_2026-11-09T08:00:00.000Z/done"))[1]).not.toBeNull()
  })

  it.each([1, 2])("retries a Static Schedule after a lease outage within its catch-up window (minutes late: %s)", async (minutesLate) => {
    const leases = createMemoryLeaseStore()
    const acquire = leases.acquire.bind(leases)
    const unavailable = createSqlLeaseStore({ dialect: "postgresql", query: async () => { throw new Error("Database unavailable") } })
    let available = false
    vi.spyOn(leases, "acquire").mockImplementation((key, options) => available ? acquire(key, options) : unavailable.acquire(key, options))
    const onError = vi.fn()
    const handler = vi.fn()
    const time = clock("2026-11-09T08:00:10.000Z")
    await install(await startProcess(), {
      catchUpMs: 60_000,
      leases,
      now: time.now,
      onError,
      registry: { daily: async () => defineSchedule({ cron: "0 8 * * *", handler }) },
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())

    time.advance(minutesLate * 60_000)
    available = true
    if (minutesLate === 1) {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: minute("2026-11-09T08:00:00.000Z") }))
    }
    else {
      await sleep(100)
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])("runs each occurrence once when two processes share the leases (build timings: %s)", async (buildTimings) => {
    const time = clock("2026-11-09T08:00:10.000Z")
    const leases = createMemoryLeaseStore()
    const calls: Array<{ at: string, process: string }> = []
    const registry = (process: string) => ({
      daily: async () => defineSchedule({
        cron: "* * * * *",
        handler: async ({ scheduledAt }) => {
          calls.push({ at: scheduledAt.toISOString(), process })
          await sleep(20)
        },
      }),
    })
    // Each process has its own run history, so only the leases keep them apart.
    const timings = buildTimings ? { daily: { cron: "* * * * *" } } : undefined
    await install(await startProcess(), { leases, now: time.now, registry: registry("a"), timings })
    await install(await startProcess(), { leases, now: time.now, registry: registry("b"), timings })

    for (let index = 0; index < 3; index++) {
      if (index > 0) time.advance(60_000)
      await vi.waitFor(() => expect(calls).toHaveLength(index + 1))
      // Both processes scan many times in this minute.
      await sleep(100)
    }

    expect(calls.map(call => call.at)).toEqual([
      "2026-11-09T08:00:00.000Z",
      "2026-11-09T08:01:00.000Z",
      "2026-11-09T08:02:00.000Z",
    ])
  })

  it("catches up a missed minute once when two processes restart", async () => {
    const leases = createMemoryLeaseStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const previous = minute("2026-10-16T14:50:00.000Z")
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: previous, id: "srun_static_reconcile_2026-10-16T14:50:00.000Z", scheduleId: "reconcile", scheduledAt: previous, status: "succeeded", target: "reconcile", updatedAt: previous })
    const handler = vi.fn(async () => sleep(20))
    const registry = { reconcile: async () => defineSchedule({ cron: "*/10 * * * *", handler }) }
    const now = () => minute("2026-10-16T15:01:20.000Z")

    await Promise.all([
      startProcess().then(server => install(server, { catchUpMs: 60 * 60_000, leases, now, registry, scheduleRunStore })),
      startProcess().then(server => install(server, { catchUpMs: 60 * 60_000, leases, now, registry, scheduleRunStore })),
    ])
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))
    await sleep(150)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: minute("2026-10-16T15:00:00.000Z") }))
  })

  it("runs an occurrence after the claim of a crashed process ends, as a new attempt of its run", async () => {
    const leases = createMemoryLeaseStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const scheduledAt = minute("2026-11-09T08:00:00.000Z")
    const runId = "srun_static_daily_2026-11-09T08:00:00.000Z"
    // The crashed process claimed the occurrence, started its run, and stopped without a done marker.
    const [, crashed] = await leases.acquire(`vitehub:schedule/schedule/${runId}`, { owner: "crashed", ttl: 0.3 })
    expect(crashed).not.toBeNull()
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: scheduledAt, id: runId, scheduleId: "daily", scheduledAt, startedAt: scheduledAt, status: "running", target: "daily", updatedAt: scheduledAt })
    await scheduleRunStore.createAttempt({ createdAt: scheduledAt, id: "satt_crashed", runId, startedAt: scheduledAt, status: "running", updatedAt: scheduledAt })
    const handler = vi.fn()
    const startedAt = Date.now()

    await install(await startProcess(), {
      leases,
      now: () => minute("2026-11-09T08:00:10.000Z"),
      registry: { daily: async () => defineSchedule({ cron: "* * * * *", handler }) },
      scheduleRunStore,
    })
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 2000 })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
    expect(await scheduleRunStore.getRun(runId)).toEqual(expect.objectContaining({ attemptCount: 2, status: "succeeded" }))
    expect(await scheduleRunStore.getAttempt("satt_crashed")).toEqual(expect.objectContaining({
      error: expect.objectContaining({ name: "ScheduleAttemptStopped" }),
      status: "failed",
    }))
  })

  it.each([false, true])("runs an unfinished occurrence once when every process restarts after its minute (build timings: %s)", async (buildTimings) => {
    const leases = createMemoryLeaseStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const scheduledAt = minute("2026-11-09T08:00:00.000Z")
    const runId = "srun_static_daily_2026-11-09T08:00:00.000Z"
    // At 08:00 a process claimed the occurrence, recorded its run as running, and crashed. Every process stopped.
    await leases.acquire(`vitehub:schedule/schedule/${runId}`, { owner: "crashed", ttl: 0.3 })
    await scheduleRunStore.createRun({ attemptCount: 1, createdAt: scheduledAt, id: runId, scheduleId: "daily", scheduledAt, startedAt: scheduledAt, status: "running", target: "daily", updatedAt: scheduledAt })
    await scheduleRunStore.createAttempt({ createdAt: scheduledAt, id: "satt_crashed", runId, startedAt: scheduledAt, status: "running", updatedAt: scheduledAt })
    const calls: string[] = []
    const registry = {
      daily: async () => defineSchedule({
        cron: "* * * * *",
        handler: async (context: ScheduleRunContext) => {
          calls.push(context.scheduledAt.toISOString())
          await sleep(20)
        },
      }),
    }
    const now = () => minute("2026-11-09T08:02:10.000Z")

    // Two processes start at 08:02 with an empty memory.
    const timings = buildTimings ? { daily: { cron: "* * * * *" } } : undefined
    await install(await startProcess(), { catchUpMs: 60 * 60_000, leases, now, registry, scheduleRunStore, timings })
    await install(await startProcess(), { catchUpMs: 60 * 60_000, leases, now, registry, scheduleRunStore, timings })
    await vi.waitFor(() => expect(calls).toContain("2026-11-09T08:00:00.000Z"), { timeout: 2000 })
    await sleep(300)

    expect(calls.toSorted()).toEqual(["2026-11-09T08:00:00.000Z", "2026-11-09T08:01:00.000Z", "2026-11-09T08:02:00.000Z"])
    expect(await scheduleRunStore.getRun(runId)).toEqual(expect.objectContaining({ attemptCount: 2, status: "succeeded" }))
  })

  it("does not run an occurrence again when the crashed process finished it", async () => {
    const leases = createMemoryLeaseStore()
    const runId = "srun_static_daily_2026-11-09T08:00:00.000Z"
    // The process finished the run and wrote the done marker, then stopped before it released its claim.
    await leases.acquire(`vitehub:schedule/schedule/${runId}`, { ttl: 0.1 })
    await leases.acquire(`vitehub:schedule/schedule/${runId}/done`, { ttl: 60 })
    const handler = vi.fn()

    await install(await startProcess(), {
      leases,
      now: () => minute("2026-11-09T08:00:10.000Z"),
      registry: { daily: async () => defineSchedule({ cron: "* * * * *", handler }) },
    })
    await sleep(400)

    expect(handler).not.toHaveBeenCalled()
  })

  it("runs each occurrence of a started Schedule once", async () => {
    const time = clock("2026-11-09T08:00:10.000Z")
    const leases = createMemoryLeaseStore()
    const startedStore = createMemoryStartedScheduleStore()
    await startedStore.put({ createdAt: minute("2026-11-09T07:58:00.000Z"), cron: "* * * * *", id: "ssch_report", name: "report", payload: { to: "ops" } })
    const calls: Array<{ at: string, payload: unknown }> = []
    const startedRegistry = {
      report: async () => defineSchedule({
        handler: async (context: ScheduleRunContext & { payload?: unknown }) => {
          calls.push({ at: context.scheduledAt.toISOString(), payload: context.payload })
          await sleep(20)
        },
      }),
    }
    for (let index = 0; index < 2; index++) {
      const server = await startProcess()
      await install(server, {
        leases,
        now: time.now,
        registry: { "vitehub/started-schedules": async () => defineSchedule({ cron: "* * * * *", handler: server.started.runStartedSchedules }) },
        startedRegistry,
        startedStore,
      })
    }

    for (let index = 0; index < 2; index++) {
      if (index > 0) time.advance(60_000)
      await vi.waitFor(() => expect(calls).toHaveLength(index + 1))
      await sleep(100)
    }

    expect(calls).toEqual([
      { at: "2026-11-09T08:00:00.000Z", payload: { to: "ops" } },
      { at: "2026-11-09T08:01:00.000Z", payload: { to: "ops" } },
    ])
  })

  it("runs a manual run once, on the process that gets it", async () => {
    const leases = createMemoryLeaseStore()
    const handler = vi.fn()
    const registry = { report: async () => defineSchedule({ cron: "0 0 1 1 *", handler, manual: true }) }
    const now = () => minute("2026-11-09T08:00:10.000Z")
    const first = await startProcess()
    await install(first, { leases, now, registry })
    await install(await startProcess(), { leases, now, registry })

    const run = await first.execute.runSchedule("report")
    await sleep(100)

    expect(run.status).toBe("succeeded")
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
