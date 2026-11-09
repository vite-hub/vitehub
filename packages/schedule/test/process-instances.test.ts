import { createMemoryLeaseStore } from "@vite-hub/runtime"
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
  registry: ScheduleDefinitionRegistry
  scheduleRunStore?: ScheduleRunStore
  startedStore?: StartedScheduleStore
  startedRegistry?: ScheduleDefinitionRegistry
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
    onError: error => console.error(error),
    registry: options.registry,
    scheduleRunStore: options.scheduleRunStore ?? createMemoryScheduleRunStore(),
  })
  controllers.push(controller)
  return controller
}

describe("Process Runtime on more than one process", () => {
  it("runs each occurrence once when two processes share the leases", async () => {
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
    await install(await startProcess(), { leases, now: time.now, registry: registry("a") })
    await install(await startProcess(), { leases, now: time.now, registry: registry("b") })

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
    const [, crashed] = await leases.acquire(`schedule/${runId}`, { owner: "crashed", ttl: 0.3 })
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

  it("does not run an occurrence again when the crashed process finished it", async () => {
    const leases = createMemoryLeaseStore()
    const runId = "srun_static_daily_2026-11-09T08:00:00.000Z"
    // The process finished the run and wrote the done marker, then stopped before it released its claim.
    await leases.acquire(`schedule/${runId}`, { ttl: 0.1 })
    await leases.acquire(`schedule/${runId}/done`, { ttl: 60 })
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
