import { afterEach, describe, expect, it, vi } from "vitest"

import { defineScheduleTarget, executeStaticSchedule, schedules } from "../src/index.ts"
import { installScheduleRuntime } from "../src/runtime/driver.ts"
import { resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryRuntimeScheduleStore, createMemoryScheduleRunStore } from "../src/runtime/store.ts"

import type { RuntimeScheduleRecord } from "../src/types.ts"
import type { RuntimeScheduleWakeDriverContext } from "../src/runtime/driver.ts"

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  resetScheduleRuntime()
})

describe("Schedule waitUntil", () => {
  it("drains locally deferred work before completing a run", async () => {
    let releaseDeferred: (() => void) | undefined
    let deferredCompleted = false
    const execution = executeStaticSchedule({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler: async ({ waitUntil }) => {
          waitUntil(new Promise<void>((resolve) => {
            releaseDeferred = () => {
              deferredCompleted = true
              resolve()
            }
          }))
        },
      },
      name: "static-report",
      scheduledAt: new Date("2026-05-23T10:00:00.000Z"),
    })

    await vi.waitFor(() => expect(releaseDeferred).toBeTypeOf("function"))
    expect(deferredCompleted).toBe(false)
    expect(await schedules.listRuns()).toEqual([
      expect.objectContaining({ status: "running" }),
    ])

    releaseDeferred!()

    await expect(execution).resolves.toMatchObject({ status: "succeeded" })
    expect(deferredCompleted).toBe(true)
  })

  it("fails a run when locally deferred work rejects", async () => {
    const controller = await installScheduleRuntime({
      createDriver: () => ({ async reconcile() {} }),
      registry: {
        report: async () => defineScheduleTarget({
          handler: async ({ waitUntil }) => {
            waitUntil(Promise.reject(new TypeError("deferred failed")))
          },
        }),
      },
      runtimeScheduleStore: createMemoryRuntimeScheduleStore(),
      scheduleRunStore: createMemoryScheduleRunStore(),
    })
    await schedules.create({ cron: "0 9 * * *", id: "schedule-1", target: "report" })

    await expect(schedules.run("schedule-1", {
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
    })).rejects.toThrow("deferred failed")

    const [run] = await schedules.listRuns()
    expect(run).toMatchObject({
      error: { message: "deferred failed", name: "TypeError" },
      status: "failed",
    })
    const [attempt] = await schedules.listAttempts(run!.id)
    expect(attempt).toMatchObject({
      error: { message: "deferred failed", name: "TypeError" },
      status: "failed",
    })
    await controller.close()
  })

  it("drains locally deferred work before recording a handler failure", async () => {
    let releaseDeferred: (() => void) | undefined
    let deferredCompleted = false
    const execution = executeStaticSchedule({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler: async ({ waitUntil }) => {
          waitUntil(new Promise<void>((resolve) => {
            releaseDeferred = () => {
              deferredCompleted = true
              resolve()
            }
          }))
          throw new Error("handler failed")
        },
      },
      name: "static-report",
      scheduledAt: new Date("2026-05-23T10:00:00.000Z"),
    })

    await vi.waitFor(() => expect(releaseDeferred).toBeTypeOf("function"))
    expect(await schedules.listRuns()).toEqual([
      expect.objectContaining({ status: "running" }),
    ])

    releaseDeferred!()

    await expect(execution).rejects.toThrow("handler failed")
    expect(deferredCompleted).toBe(true)
    expect(await schedules.listRuns()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ message: "handler failed" }),
        status: "failed",
      }),
    ])
  })

  it("propagates driver-owned work, reports rejections, and drains on close", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    const releases: Array<() => void> = []
    const completed: string[] = []
    const onError = vi.fn()
    let driverClosed = false
    let context: RuntimeScheduleWakeDriverContext | undefined
    let reconciled: RuntimeScheduleRecord[] = []
    await runtimeScheduleStore.create({
      createdAt: scheduledAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "runtime-report",
      target: "report",
      updatedAt: scheduledAt,
    })
    const defer = (name: string) => new Promise<void>((resolve) => {
      releases.push(() => {
        completed.push(name)
        resolve()
      })
    })
    const controller = await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async close() {
            driverClosed = true
          },
          async reconcile(records) {
            reconciled = [...records]
          },
        }
      },
      onError,
      registry: {
        report: async () => defineScheduleTarget({
          handler: async ({ waitUntil }) => {
            waitUntil(defer("runtime"))
            waitUntil(Promise.reject(new Error("deferred driver failure")))
          },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
      staticRegistry: {
        "static-report": async () => ({
          cron: "0 9 * * *",
          handler: async ({ waitUntil }) => waitUntil(defer("static")),
        }),
      },
    })

    const staticSchedule = reconciled.find(schedule => schedule.target === "static-report")!
    await context!.wake({ scheduleId: staticSchedule.id, scheduledAt })
    await context!.wake({ scheduleId: "runtime-report", scheduledAt })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "deferred driver failure",
    })))
    expect(releases).toHaveLength(2)
    expect(completed).toEqual([])

    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await flushAsyncWork()
    expect(closed).toBe(false)
    expect(driverClosed).toBe(false)
    await context!.wake({ scheduleId: "runtime-report", scheduledAt: new Date("2026-07-12T09:00:00.000Z") })
    expect(releases).toHaveLength(2)

    for (const release of releases) release()
    await closing

    expect(completed).toEqual(["static", "runtime"])
    expect(driverClosed).toBe(true)
  })

  it("waits for active wakes to register deferred work before closing", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const runtimeScheduleStore = createMemoryRuntimeScheduleStore()
    let context: RuntimeScheduleWakeDriverContext | undefined
    let releaseHandler: (() => void) | undefined
    let releaseDeferred: (() => void) | undefined
    let driverClosed = false
    await runtimeScheduleStore.create({
      createdAt: scheduledAt,
      cron: "0 9 * * *",
      enabled: true,
      id: "report",
      target: "report",
      updatedAt: scheduledAt,
    })
    const controller = await installScheduleRuntime({
      createDriver(driverContext) {
        context = driverContext
        return {
          async close() { driverClosed = true },
          async reconcile() {},
        }
      },
      registry: {
        report: async () => defineScheduleTarget({
          handler: async ({ waitUntil }) => {
            await new Promise<void>(resolve => { releaseHandler = resolve })
            waitUntil(new Promise<void>(resolve => { releaseDeferred = resolve }))
          },
        }),
      },
      runtimeScheduleStore,
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    const wake = context!.wake({ scheduleId: "report", scheduledAt })
    await vi.waitFor(() => expect(releaseHandler).toBeTypeOf("function"))
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    releaseHandler!()
    await vi.waitFor(() => expect(releaseDeferred).toBeTypeOf("function"))
    expect(closed).toBe(false)
    expect(driverClosed).toBe(false)
    releaseDeferred!()
    await Promise.all([wake, closing])
    expect(driverClosed).toBe(true)
  })
})
