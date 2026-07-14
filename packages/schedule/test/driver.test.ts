import { afterEach, describe, expect, it, vi } from "vitest"

import { schedules } from "../src/runtime/client.ts"
import { installScheduleRuntime } from "../src/runtime/driver.ts"
import { createProcessScheduleWakeDriver } from "../src/runtime/process.ts"
import {
  getRuntimeScheduleStore,
  getScheduleRunStore,
  loadScheduleDefinition,
  resetScheduleRuntime,
  setRuntimeScheduleStore,
  setScheduleRunStore,
  setScheduleRuntimeRegistry,
} from "../src/runtime/state.ts"
import { createMemoryRuntimeScheduleStore, createMemoryScheduleRunStore } from "../src/runtime/store.ts"

import type { RuntimeScheduleRecord, ScheduleDefinitionRegistry } from "../src/types.ts"
import type { RuntimeScheduleWakeDriver, RuntimeScheduleWakeDriverContext } from "../src/runtime/driver.ts"

const registry: ScheduleDefinitionRegistry = {
  report: async () => ({
    cron: "0 9 * * *",
    handler: async () => {},
    options: { allowRuntimeSchedules: true },
  }),
}

function snapshot(schedules: readonly RuntimeScheduleRecord[]) {
  return schedules.map(({ cron, enabled, id, target }) => ({ cron, enabled, id, target }))
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  resetScheduleRuntime()
})

describe("Runtime Schedule Wake Driver", () => {
  it("runs a due Static Schedule during the Process Driver startup reconciliation", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const handler = vi.fn()
    const controller = await installScheduleRuntime({
      createDriver: createProcessScheduleWakeDriver({ now: () => scheduledAt }),
      registry: {},
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
      staticRegistry: {
        "daily-report": async () => ({ cron: "0 9 * * *", handler }),
      },
    })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: "daily-report", scheduledAt }))
    await controller.close()
  })

  it("reconciles and dispatches Static and Runtime Schedules through one driver", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const staticHandler = vi.fn()
    const runtimeHandler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let reconciled: RuntimeScheduleRecord[] = []
    await runtimeScheduleStore.create({ createdAt: now, cron: "30 9 * * *", enabled: true, id: "weekday-report", target: "runtime-report", updatedAt: now })

    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async reconcile(records) {
            reconciled = [...records]
          },
        }
      },
      registry: {
        "runtime-report": async () => ({ handler: runtimeHandler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
      staticRegistry: {
        "daily-report": async () => ({ cron: "0 9 * * *", handler: staticHandler }),
        "runtime-report": async () => ({ handler: runtimeHandler, options: { allowRuntimeSchedules: true } }),
      },
    })

    expect(reconciled).toHaveLength(2)
    const staticSchedule = reconciled.find(schedule => schedule.target === "daily-report")!
    expect(staticSchedule).toMatchObject({ cron: "0 9 * * *", enabled: true, target: "daily-report" })
    await context!.wake({ scheduleId: staticSchedule.id, scheduledAt: new Date("2026-07-11T09:00:00.000Z") })
    await context!.wake({ scheduleId: "weekday-report", scheduledAt: new Date("2026-07-11T09:30:00.000Z") })

    expect(staticHandler).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "daily-report",
      scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
    }))
    expect(runtimeHandler).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "weekday-report",
      scheduledAt: new Date("2026-07-11T09:30:00.000Z"),
    }))
    expect(await scheduleRunStore.listRuns()).toHaveLength(2)
  })

  it("rejects Static Schedule wakes that are not due", async () => {
    const staticHandler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let reconciled: RuntimeScheduleRecord[] = []

    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async reconcile(records) {
            reconciled = [...records]
          },
        }
      },
      registry: {},
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
      staticRegistry: {
        "daily-report": async () => ({ cron: "0 9 * * *", handler: staticHandler }),
      },
    })

    const staticSchedule = reconciled.find(schedule => schedule.target === "daily-report")!
    await expect(context!.wake({ scheduleId: staticSchedule.id, scheduledAt: new Date("2026-07-11T09:30:00.000Z") })).rejects.toMatchObject({
      code: "SCHEDULE_NOT_DUE",
    })
    expect(staticHandler).not.toHaveBeenCalled()
  })

  it("loads Static Schedule definitions from module default exports before named exports", async () => {
    const defaultHandler = vi.fn()
    const namedHandler = vi.fn()
    let reconciled: RuntimeScheduleRecord[] = []

    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          reconciled = [...records]
        },
      }),
      registry: {},
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
      staticRegistry: {
        "daily-report": async () => ({
          default: { cron: "0 9 * * *", handler: defaultHandler },
          handler: namedHandler,
        }),
      },
    })

    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({ cron: "0 9 * * *", target: "daily-report" })
  })

  it("keeps Static Schedule driver identities distinct from persisted ids", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const staticHandler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let reconciled: RuntimeScheduleRecord[] = []
    await runtimeScheduleStore.create({
      createdAt: now,
      cron: "30 9 * * *",
      enabled: true,
      id: "\0vitehub:static:daily-report",
      target: "runtime-report",
      updatedAt: now,
    })

    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async reconcile(records) {
            reconciled = [...records]
          },
        }
      },
      registry: {
        "runtime-report": async () => ({ handler: async () => {}, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
      staticRegistry: {
        "daily-report": async () => ({ cron: "0 9 * * *", handler: staticHandler }),
      },
    })

    expect(new Set(reconciled.map(schedule => schedule.id)).size).toBe(2)
    const staticSchedule = reconciled.find(schedule => schedule.target === "daily-report")!
    expect(staticSchedule.id).not.toBe("\0vitehub:static:daily-report")
    await expect(schedules.create({
      cron: "0 10 * * *",
      id: staticSchedule.id,
      target: "runtime-report",
    })).rejects.toThrow("conflicts with a Static Schedule driver identity")
    expect(await runtimeScheduleStore.get(staticSchedule.id)).toBeUndefined()
    await context!.wake({ scheduleId: staticSchedule.id, scheduledAt: new Date("2026-07-11T09:00:00.000Z") })
    expect(staticHandler).toHaveBeenCalledOnce()
  })

  it("reconciles the complete stored snapshot before installation succeeds", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T09:00:00.000Z")
    await runtimeScheduleStore.create({ createdAt: now, cron: "0 9 * * *", enabled: true, id: "enabled", target: "report", updatedAt: now })
    await runtimeScheduleStore.create({ createdAt: now, cron: "0 10 * * *", enabled: false, id: "disabled", target: "report", updatedAt: now })
    let releaseReconcile: (() => void) | undefined
    const snapshots: unknown[] = []

    const installing = installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
          await new Promise<void>(resolve => { releaseReconcile = resolve })
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore,
    })
    await flushAsyncWork()

    expect(snapshots).toEqual([[
      { cron: "0 9 * * *", enabled: true, id: "enabled", target: "report" },
      { cron: "0 10 * * *", enabled: false, id: "disabled", target: "report" },
    ]])

    let installed = false
    void installing.then(() => { installed = true })
    await flushAsyncWork()
    expect(installed).toBe(false)

    releaseReconcile?.()
    await installing
  })

  it("queues mutations until the initial snapshot is reconciled", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const snapshots: unknown[] = []
    let releaseReconcile: (() => void) | undefined
    const installing = installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
          if (snapshots.length === 1) {
            await new Promise<void>(resolve => { releaseReconcile = resolve })
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    await flushAsyncWork()

    const creating = schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })
    await flushAsyncWork()
    expect(await runtimeScheduleStore.list()).toEqual([])

    releaseReconcile?.()
    await Promise.all([installing, creating])
    expect(snapshots).toEqual([
      [],
      [{ cron: "0 9 * * *", enabled: true, id: "daily", target: "report" }],
    ])
  })

  it("rejects queued mutations without writing when installation fails", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    let rejectReconcile: (() => void) | undefined
    let reconcileCount = 0
    const installing = installScheduleRuntime({
      createDriver: () => ({
        async reconcile() {
          reconcileCount++
          if (reconcileCount === 1) {
            await new Promise<void>(resolve => { rejectReconcile = resolve })
            throw new Error("initial reconcile failed")
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    await flushAsyncWork()

    const creating = schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })
    await flushAsyncWork()
    rejectReconcile?.()

    await expect(installing).rejects.toThrow("initial reconcile failed")
    await expect(creating).rejects.toThrow("installation did not complete")
    expect(await runtimeScheduleStore.list()).toEqual([])
  })

  it("delivers exact wake identity and time through Runtime Schedule execution", async () => {
    const scheduledAt = new Date("2026-07-11T09:30:00.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const handler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    await runtimeScheduleStore.create({ createdAt: now, cron: "30 9 * * *", enabled: true, id: "weekday-report", target: "report", updatedAt: now })

    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return { async reconcile() {} }
      },
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler,
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })

    await context!.wake({ scheduleId: "weekday-report", scheduledAt })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: "weekday-report",
      scheduledAt,
    }))
    expect(await scheduleRunStore.getRun("srun_runtime_weekday-report_2026-07-11T09:30:00.000Z")).toMatchObject({
      scheduleId: "weekday-report",
      scheduledAt,
      status: "succeeded",
    })
  })

  it("delivers timezone-aware native wakes", async () => {
    const scheduledAt = new Date("2026-07-11T02:00:00.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T01:00:00.000Z")
    const handler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    await runtimeScheduleStore.create({
      createdAt: now,
      cron: "0 9 * * *",
      enabled: true,
      id: "bangkok-report",
      target: "report",
      timeZone: "Asia/Bangkok",
      updatedAt: now,
    })

    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return { async reconcile() {} }
      },
      registry: {
        report: async () => ({ cron: "0 9 * * *", handler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })

    await context!.wake({ scheduleId: "bangkok-report", scheduledAt })

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt }))
  })

  it("lets initial reconciliation await a native wake", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const handler = vi.fn()
    await runtimeScheduleStore.create({
      createdAt: scheduledAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "daily",
      target: "report",
      updatedAt: scheduledAt,
    })

    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (records.some(record => record.id === "daily")) {
            await context.wake({ scheduleId: "daily", scheduledAt })
          }
        },
      }),
      registry: {
        report: async () => ({ cron: "0 9 * * *", handler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })

    expect(handler).toHaveBeenCalledOnce()
  })

  it("lets a handler woken during initial reconciliation mutate Runtime Schedules", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    await runtimeScheduleStore.create({
      createdAt: scheduledAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "daily",
      target: "report",
      updatedAt: scheduledAt,
    })

    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (records.some(record => record.id === "daily")) {
            await context.wake({ scheduleId: "daily", scheduledAt })
          }
        },
      }),
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => {
            await schedules.create({ cron: "0 10 * * *", id: "follow-up", target: "report" })
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await expect(schedules.get("follow-up")).resolves.toMatchObject({ id: "follow-up" })
  })

  it("lets mutation reconciliation await a native wake", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const handler = vi.fn()
    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (records.some(record => record.id === "daily")) {
            await context.wake({ scheduleId: "daily", scheduledAt })
          }
        },
      }),
      registry: {
        report: async () => ({ cron: "0 9 * * *", handler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })

    expect(handler).toHaveBeenCalledOnce()
  })

  it("lets a handler woken during mutation reconciliation mutate Runtime Schedules", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (records.some(record => record.id === "daily")) {
            await context.wake({ scheduleId: "daily", scheduledAt })
          }
        },
      }),
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => {
            await schedules.create({ cron: "0 10 * * *", id: "follow-up", target: "report" })
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })

    await expect(schedules.get("follow-up")).resolves.toMatchObject({ id: "follow-up" })
  })

  it("reconciles re-entrant handler mutations after the active snapshot", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const snapshots: string[][] = []
    let concurrentReconcile = false
    let reconciling = false
    let woke = false
    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (reconciling) concurrentReconcile = true
          reconciling = true
          try {
            if (!woke && records.some(record => record.id === "daily")) {
              woke = true
              await context.wake({ scheduleId: "daily", scheduledAt })
            }
            snapshots.push(records.map(record => record.id))
          }
          finally {
            reconciling = false
          }
        },
      }),
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => {
            await schedules.create({ cron: "0 10 * * *", id: "follow-up", target: "report" })
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })

    expect(concurrentReconcile).toBe(false)
    expect(snapshots.at(-1)).toEqual(["daily", "follow-up"])
  })

  it("rolls back and rejects a re-entrant mutation when deferred reconciliation fails", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const reconciliationError = new Error("host reconcile failed")
    let mutationError: unknown
    let woke = false
    await installScheduleRuntime({
      createDriver: context => ({
        async reconcile(records) {
          if (records.some(record => record.id === "follow-up")) throw reconciliationError
          if (!woke && records.some(record => record.id === "daily")) {
            woke = true
            await context.wake({ scheduleId: "daily", scheduledAt })
          }
        },
      }),
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => {
            try {
              await schedules.create({ cron: "0 10 * * *", id: "follow-up", target: "report" })
            }
            catch (error) {
              mutationError = error
            }
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })

    expect(mutationError).toBe(reconciliationError)
    await expect(schedules.get("follow-up")).resolves.toBeUndefined()
  })

  it("executes native wakes against persisted mutations while reconciliation is pending", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const handler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let releaseReconcile: (() => void) | undefined
    let markReconcileStarted: (() => void) | undefined
    const reconcileStarted = new Promise<void>(resolve => { markReconcileStarted = resolve })
    let reconcileCount = 0
    await runtimeScheduleStore.create({ createdAt: now, cron: "0 9 * * *", enabled: true, id: "daily", target: "report", updatedAt: now })
    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async reconcile() {
            reconcileCount++
            if (reconcileCount === 2) {
              markReconcileStarted?.()
              await new Promise<void>(resolve => { releaseReconcile = resolve })
            }
          },
        }
      },
      registry: {
        report: async () => ({ cron: "0 9 * * *", handler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })

    const updating = schedules.update("daily", { cron: "0 10 * * *" })
    await reconcileStarted
    const waking = context!.wake({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
    })
    await expect(waking).rejects.toMatchObject({ code: "SCHEDULE_NOT_DUE" })
    expect(handler).not.toHaveBeenCalled()

    releaseReconcile?.()
    await updating
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects native wakes outside the exact minute occurrence", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const handler = vi.fn()
    let context: RuntimeScheduleWakeDriverContext | undefined
    await runtimeScheduleStore.create({ createdAt: now, cron: "0 9 * * *", enabled: true, id: "daily", target: "report", updatedAt: now })
    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return { async reconcile() {} }
      },
      registry: {
        report: async () => ({ cron: "0 9 * * *", handler, options: { allowRuntimeSchedules: true } }),
      },
      runtimeScheduleStore,
      scheduleRunStore,
    })

    await expect(context!.wake({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:00:30.000Z"),
    })).rejects.toMatchObject({ code: "SCHEDULE_NOT_DUE" })
    await expect(context!.wake({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:00:00.001Z"),
    })).rejects.toMatchObject({ code: "SCHEDULE_NOT_DUE" })
    expect(handler).not.toHaveBeenCalled()
    expect(await scheduleRunStore.listRuns()).toEqual([])

    await context!.wake({
      scheduleId: "daily",
      scheduledAt: new Date("2026-07-11T09:00:00.000Z"),
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it("reconciles serialized full snapshots after create, update, and delete", async () => {
    const snapshots: unknown[] = []
    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
        },
      }),
      registry,
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })
    await schedules.update("daily", { cron: "30 9 * * *", enabled: false })
    await schedules.delete("daily")

    expect(snapshots).toEqual([
      [],
      [{ cron: "0 9 * * *", enabled: true, id: "daily", target: "report" }],
      [{ cron: "30 9 * * *", enabled: false, id: "daily", target: "report" }],
      [],
    ])
  })

  it("does not let concurrent mutations reorder driver snapshots", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const snapshots: unknown[] = []
    let releaseFirstMutation: (() => void) | undefined
    let markFirstMutationStarted: (() => void) | undefined
    const firstMutationStarted = new Promise<void>(resolve => { markFirstMutationStarted = resolve })
    let reconcileCount = 0
    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          reconcileCount++
          snapshots.push(snapshot(records))
          if (reconcileCount === 2) {
            markFirstMutationStarted?.()
            await new Promise<void>(resolve => { releaseFirstMutation = resolve })
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    const first = schedules.create({ cron: "0 9 * * *", id: "first", target: "report" })
    await firstMutationStarted
    const second = schedules.create({ cron: "0 10 * * *", id: "second", target: "report" })
    await flushAsyncWork()

    expect(snapshot(await runtimeScheduleStore.list())).toEqual([
      { cron: "0 9 * * *", enabled: true, id: "first", target: "report" },
    ])

    releaseFirstMutation!()
    await Promise.all([first, second])

    expect(snapshots).toEqual([
      [],
      [{ cron: "0 9 * * *", enabled: true, id: "first", target: "report" }],
      [
        { cron: "0 9 * * *", enabled: true, id: "first", target: "report" },
        { cron: "0 10 * * *", enabled: true, id: "second", target: "report" },
      ],
    ])
  })

  it("rolls back a created record when reconciliation fails", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const snapshots: unknown[] = []
    let rejectNext = false
    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
          if (rejectNext) {
            rejectNext = false
            throw new Error("host create failed")
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    rejectNext = true
    await expect(schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })).rejects.toThrow("host create failed")

    expect(await runtimeScheduleStore.list()).toEqual([])
    expect(snapshots).toEqual([
      [],
      [{ cron: "0 9 * * *", enabled: true, id: "daily", target: "report" }],
      [],
    ])
  })

  it("rolls back an updated record when reconciliation fails", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const original = await runtimeScheduleStore.create({ createdAt: now, cron: "0 9 * * *", enabled: true, id: "daily", target: "report", updatedAt: now })
    const deleteRecord = vi.spyOn(runtimeScheduleStore, "delete")
    const createRecord = vi.spyOn(runtimeScheduleStore, "create")
    const snapshots: unknown[] = []
    let rejectNext = false
    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
          if (rejectNext) {
            rejectNext = false
            throw new Error("host update failed")
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    rejectNext = true
    await expect(schedules.update("daily", { cron: "30 9 * * *", enabled: false })).rejects.toThrow("host update failed")

    expect(await runtimeScheduleStore.get("daily")).toEqual(original)
    expect(deleteRecord).toHaveBeenCalledWith("daily")
    expect(createRecord).toHaveBeenCalledWith(original)
    expect(snapshots).toEqual([
      [{ cron: "0 9 * * *", enabled: true, id: "daily", target: "report" }],
      [{ cron: "30 9 * * *", enabled: false, id: "daily", target: "report" }],
      [{ cron: "0 9 * * *", enabled: true, id: "daily", target: "report" }],
    ])
  })

  it("rolls back a deleted record when reconciliation fails", async () => {
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const now = new Date("2026-07-11T08:00:00.000Z")
    const original = await runtimeScheduleStore.create({ createdAt: now, cron: "0 9 * * *", enabled: false, id: "daily", target: "report", updatedAt: now })
    const snapshots: unknown[] = []
    let rejectNext = false
    await installScheduleRuntime({
      createDriver: () => ({
        async reconcile(records) {
          snapshots.push(snapshot(records))
          if (rejectNext) {
            rejectNext = false
            throw new Error("host delete failed")
          }
        },
      }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    rejectNext = true
    await expect(schedules.delete("daily")).rejects.toThrow("host delete failed")

    expect(await runtimeScheduleStore.get("daily")).toEqual(original)
    expect(snapshots).toEqual([
      [{ cron: "0 9 * * *", enabled: false, id: "daily", target: "report" }],
      [],
      [{ cron: "0 9 * * *", enabled: false, id: "daily", target: "report" }],
    ])
  })

  it("does not reconcile manual runs", async () => {
    const reconcile = vi.fn<RuntimeScheduleWakeDriver["reconcile"]>()
    let calls = 0
    await installScheduleRuntime({
      createDriver: () => ({ reconcile }),
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => { calls++ },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })
    expect(reconcile).toHaveBeenCalledTimes(2)

    await schedules.run("daily", { scheduledAt: new Date("2026-07-11T09:00:00.000Z") })

    expect(calls).toBe(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it("closes driver resources once without clearing configured runtime state", async () => {
    const close = vi.fn(async () => {})
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const scheduleRunStore = createMemoryScheduleRunStore()
    const controller = await installScheduleRuntime({
      createDriver: () => ({ close, async reconcile() {} }),
      registry,
      runtimeScheduleStore,
      scheduleRunStore,
    })
    await schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })

    const firstClose = controller.close()
    const secondClose = controller.close()
    expect(secondClose).toBe(firstClose)
    await firstClose

    expect(close).toHaveBeenCalledOnce()
    expect(await schedules.get("daily")).toMatchObject({ id: "daily" })
    expect(await loadScheduleDefinition("report")).toBeDefined()
  })

  it("waits for queued Runtime Schedule mutations before closing the driver", async () => {
    let releaseReconcile: (() => void) | undefined
    let driverClosed = false
    const controller = await installScheduleRuntime({
      createDriver: () => ({
        async close() { driverClosed = true },
        async reconcile(records) {
          if (records.some(record => record.id === "daily")) {
            await new Promise<void>(resolve => { releaseReconcile = resolve })
          }
        },
      }),
      registry,
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    const mutation = schedules.create({ cron: "0 9 * * *", id: "daily", target: "report" })
    await vi.waitFor(() => expect(releaseReconcile).toBeTypeOf("function"))
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await Promise.resolve()
    expect(driverClosed).toBe(false)
    expect(closed).toBe(false)
    releaseReconcile!()
    await Promise.all([mutation, closing])
    expect(driverClosed).toBe(true)
  })

  it("lets active wake handlers mutate Runtime Schedules while closing", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let activeWake: Promise<void> | undefined
    let releaseHandler: (() => void) | undefined
    await runtimeScheduleStore.create({
      createdAt: scheduledAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "daily",
      target: "report",
      updatedAt: scheduledAt,
    })
    const controller = await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async close() {},
          async reconcile() {},
        }
      },
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async () => {
            await new Promise<void>(resolve => { releaseHandler = resolve })
            await schedules.create({ cron: "0 10 * * *", id: "follow-up", target: "report" })
          },
          options: { allowRuntimeSchedules: true },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    activeWake = context!.wake({ scheduleId: "daily", scheduledAt })
    await vi.waitFor(() => expect(releaseHandler).toBeTypeOf("function"))
    const closing = controller.close()
    releaseHandler!()

    await vi.waitFor(() => expect(runtimeScheduleStore.get("follow-up")).toBeDefined(), {
      interval: 1,
      timeout: 250,
    })
    await Promise.all([activeWake, closing])
  })

  it("restores prior runtime state and closes resources when initial reconciliation fails", async () => {
    const previousRuntimeScheduleStore = createMemoryRuntimeScheduleStore()
    const previousScheduleRunStore = createMemoryScheduleRunStore()
    const previousRegistry: ScheduleDefinitionRegistry = {
      previous: async () => ({ cron: "0 8 * * *", handler: async () => {} }),
    }
    setRuntimeScheduleStore(previousRuntimeScheduleStore)
    setScheduleRunStore(previousScheduleRunStore)
    setScheduleRuntimeRegistry(previousRegistry)
    const close = vi.fn(async () => {})

    await expect(installScheduleRuntime({
      createDriver: () => ({
        close,
        async reconcile() {
          throw new Error("initial reconcile failed")
        },
      }),
      registry,
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })).rejects.toThrow("initial reconcile failed")

    expect(close).toHaveBeenCalledOnce()
    expect(getRuntimeScheduleStore()).toBe(previousRuntimeScheduleStore)
    expect(getScheduleRunStore()).toBe(previousScheduleRunStore)
    expect(await loadScheduleDefinition("previous")).toBeDefined()
    expect(await loadScheduleDefinition("report")).toBeUndefined()
  })

  it("isolates errors thrown by the runtime error reporter", async () => {
    let context: RuntimeScheduleWakeDriverContext | undefined
    const onError = vi.fn(() => {
      throw new Error("reporter failed")
    })
    await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return { async reconcile() {} }
      },
      onError,
      registry,
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    expect(() => context!.reportError(new Error("driver failed"))).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "driver failed" }))
  })
})
