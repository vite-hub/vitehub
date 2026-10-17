import { runInNewContext } from "node:vm"

import { beforeEach, describe, expect, it } from "vitest"

import { getScheduleRunStore, resetScheduleRuntime } from "../src/runtime/state.ts"
import { executeStaticSchedule, getScheduleTaskName, missingScheduleDefinitionError, runScheduleTask, unwrapScheduleDefinition } from "../src/runtime/static.ts"

import type { ScheduleDefinitionRegistry } from "../src/types.ts"

beforeEach(() => resetScheduleRuntime())

describe("Static Schedule runtime", () => {
  it("identifies a missing generated Schedule Definition", () => {
    expect(missingScheduleDefinitionError("cleanup")).toMatchObject({
      code: "SCHEDULE_R0034",
      message: "Missing schedule definition: cleanup",
    })
  })

  it("rejects an invalid scheduledAt value before formatting the run id", async () => {
    await expect(executeStaticSchedule({
      cron: "0 4 * * *",
      definition: { cron: "0 4 * * *", handler: async () => {} },
      name: "report",
      scheduledAt: new Date("invalid"),
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
      details: { field: "scheduledAt", valueType: "date" },
    })
  })

  it("rejects dates whose brand lookup throws", async () => {
    const scheduledAt = Object.defineProperty({}, Symbol.toStringTag, {
      get() {
        throw new Error("spoofed date")
      },
    }) as Date
    await expect(executeStaticSchedule({
      cron: "0 4 * * *",
      definition: { cron: "0 4 * * *", handler: async () => {} },
      name: "report",
      scheduledAt,
    })).rejects.toMatchObject({
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
    })
  })

  it("runs the Definition of a Nitro task and records the run", async () => {
    const calls: string[] = []
    const registry: ScheduleDefinitionRegistry = {
      report: async () => ({ default: { cron: "0 4 * * *", handler: ({ scheduledAt }) => calls.push(scheduledAt.toISOString()) } }),
    }

    const { result } = await runScheduleTask({ name: getScheduleTaskName("report") }, registry)

    expect(getScheduleTaskName("report")).toBe("vitehub:schedule:report")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/:00\.000Z$/)
    expect(result).toMatchObject({ scheduleId: "report", status: "succeeded" })
    expect(await getScheduleRunStore().listRuns({ scheduleId: "report" })).toHaveLength(1)
  })

  it("passes the Nitro and Cloudflare task waitUntil to the handler", async () => {
    const hosted: Array<PromiseLike<unknown>> = []
    const cloudflareContext = { waitUntil(promise: PromiseLike<unknown>) { hosted.push(promise) } }
    const registry: ScheduleDefinitionRegistry = {
      report: async () => ({ cron: "0 4 * * *", handler: ({ waitUntil }) => waitUntil(Promise.resolve("deferred")) }),
    }

    await runScheduleTask({ context: { cloudflare: { context: cloudflareContext, env: {} } }, name: getScheduleTaskName("report") }, registry)
    resetScheduleRuntime()
    await runScheduleTask({ context: { waitUntil: (promise: PromiseLike<unknown>) => hosted.push(promise) }, name: getScheduleTaskName("report") }, registry)

    expect(hosted).toHaveLength(2)
  })

  it("rejects a task without a Definition", async () => {
    await expect(runScheduleTask({ name: getScheduleTaskName("missing") }, {})).rejects.toMatchObject({ code: "SCHEDULE_R0034" })
  })

  it("unwraps definitions with cross-realm handlers and ignores inherited markers", async () => {
    const calls: string[] = []
    const handler = runInNewContext('() => calls.push("cross-realm")', { calls }) as () => void
    const definition = { cron: "0 4 * * *", handler }
    expect(handler).not.toBeInstanceOf(Function)
    expect(unwrapScheduleDefinition({ default: definition })).toBe(definition)
    expect(unwrapScheduleDefinition(Object.create({ default: definition }))).toBeUndefined()

    await runScheduleTask({ name: getScheduleTaskName("report") }, { report: async () => definition })
    expect(calls).toEqual(["cross-realm"])
  })

  it("drains deferred work before returning a handler failure", async () => {
    let releaseDeferred: (() => void) | undefined
    let deferredCompleted = false
    const execution = executeStaticSchedule({
      cron: "0 4 * * *",
      definition: {
        cron: "0 4 * * *",
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
      name: "report",
    })

    await expect.poll(() => releaseDeferred).toBeTypeOf("function")
    releaseDeferred!()

    await expect(execution).rejects.toThrow("handler failed")
    expect(deferredCompleted).toBe(true)
  })
})
