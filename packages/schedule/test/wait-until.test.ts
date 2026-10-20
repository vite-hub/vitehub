import { afterEach, describe, expect, it, vi } from "vitest"

import { executeStaticSchedule } from "../src/runtime.ts"
import { executeStaticSchedule as executeProviderStaticSchedule } from "../src/runtime/static.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { getScheduleRunStore, resetScheduleRuntime } from "../src/runtime/state.ts"
import { createMemoryScheduleRunStore } from "../src/runtime/store.ts"

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
    expect(await getScheduleRunStore().listRuns()).toEqual([
      expect.objectContaining({ status: "running" }),
    ])

    releaseDeferred!()

    await expect(execution).resolves.toMatchObject({ status: "succeeded" })
    expect(deferredCompleted).toBe(true)
  })

  it("fails a run when locally deferred work rejects", async () => {
    await expect(executeStaticSchedule({
      cron: "0 9 * * *",
      definition: {
        cron: "0 9 * * *",
        handler: async ({ waitUntil }) => {
          waitUntil(Promise.reject(new TypeError("deferred failed")))
        },
      },
      name: "report",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
    })).rejects.toThrow("deferred failed")

    const [run] = await getScheduleRunStore().listRuns()
    expect(run).toMatchObject({
      error: { message: "deferred failed", name: "TypeError" },
      status: "failed",
    })
    const [attempt] = await getScheduleRunStore().listAttempts(run!.id)
    expect(attempt).toMatchObject({
      error: { message: "deferred failed", name: "TypeError" },
      status: "failed",
    })
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
    expect(await getScheduleRunStore().listRuns()).toEqual([
      expect.objectContaining({ status: "running" }),
    ])

    releaseDeferred!()

    await expect(execution).rejects.toThrow("handler failed")
    expect(deferredCompleted).toBe(true)
    expect(await getScheduleRunStore().listRuns()).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ message: "handler failed" }),
        status: "failed",
      }),
    ])
  })

  it("propagates process-owned work, reports rejections, and drains on close", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    const releases: Array<() => void> = []
    const completed: string[] = []
    const onError = vi.fn()
    const defer = (name: string) => new Promise<void>((resolve) => {
      releases.push(() => {
        completed.push(name)
        resolve()
      })
    })
    const controller = await installProcessScheduleRuntime({
      now: () => scheduledAt,
      onError,
      registry: {
        "static-report": async () => ({
          cron: "0 9 * * *",
          handler: async ({ waitUntil }) => {
            waitUntil(defer("static"))
            waitUntil(Promise.reject(new Error("deferred process failure")))
          },
        }),
      },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "deferred process failure",
    })))
    expect(releases).toHaveLength(1)
    expect(completed).toEqual([])

    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await flushAsyncWork()
    expect(closed).toBe(false)

    for (const release of releases) release()
    await closing

    expect(completed).toEqual(["static"])
  })

  it("waits for active wakes to register deferred work before closing", async () => {
    const scheduledAt = new Date("2026-07-11T09:00:00.000Z")
    let releaseHandler: (() => void) | undefined
    let releaseDeferred: (() => void) | undefined
    const controller = await installProcessScheduleRuntime({
      now: () => scheduledAt,
      registry: {
        report: async () => ({
          cron: "0 9 * * *",
          handler: async ({ waitUntil }) => {
            await new Promise<void>(resolve => { releaseHandler = resolve })
            waitUntil(new Promise<void>(resolve => { releaseDeferred = resolve }))
          },
        }),
      },
      scheduleRunStore: createMemoryScheduleRunStore(),
    })

    await vi.waitFor(() => expect(releaseHandler).toBeTypeOf("function"))
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    releaseHandler!()
    await vi.waitFor(() => expect(releaseDeferred).toBeTypeOf("function"))
    await flushAsyncWork()
    expect(closed).toBe(false)
    releaseDeferred!()
    await closing
    expect(closed).toBe(true)
  })
})

describe.each([
  { execute: executeStaticSchedule, name: "tracked" },
  { execute: executeProviderStaticSchedule, name: "provider static" },
])("$name Schedule waitUntil ownership", ({ execute }) => {
  it("settles deferred work registered by another deferred task", async () => {
    const completed: string[] = []
    await execute({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler({ waitUntil }) {
          waitUntil(Promise.resolve().then(() => {
            completed.push("parent")
            waitUntil(Promise.resolve().then(() => { completed.push("child") }))
          }))
          return "done"
        },
      },
      name: "nested-deferred",
    })

    expect(completed).toEqual(["parent", "child"])
  })

  it("preserves the handler error when deferred work also fails", async () => {
    const handlerError = new Error("handler failure")
    await expect(execute({
      cron: "0 10 * * *",
      definition: {
        cron: "0 10 * * *",
        handler({ waitUntil }) {
          waitUntil(Promise.reject(new Error("deferred failure")))
          throw handlerError
        },
      },
      name: "error-precedence",
    })).rejects.toBe(handlerError)
  })

  it("leaves deferred settlement to the supplied host", async () => {
    let resolveDeferred!: () => void
    const deferred = new Promise<void>(resolve => { resolveDeferred = resolve })
    const hostWaitUntil = vi.fn()
    await execute({
      cron: "0 10 * * *",
      definition: { cron: "0 10 * * *", handler({ waitUntil }) { waitUntil(deferred) } },
      name: "host-deferred",
      waitUntil: hostWaitUntil,
    })

    expect(hostWaitUntil).toHaveBeenCalledWith(deferred)
    resolveDeferred()
  })
})
