import { afterEach, describe, expect, it, vi } from "vitest"

import { schedules } from "../src/runtime/client.ts"
import { installScheduleRuntime } from "../src/runtime/driver.ts"
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
