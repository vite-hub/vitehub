import { afterEach, describe, expect, it } from "vitest"

import { ScheduleError } from "../src/index.ts"
import { schedules } from "../src/runtime.ts"
import { loadScheduleDefinition, resetScheduleRuntime, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"

afterEach(() => {
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

  it("uses the replacement registry while an old registry load is in flight", async () => {
    let finishOld: (() => void) | undefined
    let newLoadCount = 0

    setScheduleRuntimeRegistry({
      report: async () => {
        await new Promise<void>(resolve => { finishOld = resolve })
        return { cron: "0 8 * * *", handler: async () => {} }
      },
    })
    const oldLoad = loadScheduleDefinition("report")
    await Promise.resolve()

    setScheduleRuntimeRegistry({
      report: async () => {
        newLoadCount++
        return { cron: "0 9 * * *", handler: async () => {} }
      },
    })

    await expect(loadScheduleDefinition("report")).resolves.toMatchObject({ cron: "0 9 * * *" })
    finishOld?.()
    await oldLoad
    await expect(loadScheduleDefinition("report")).resolves.toMatchObject({ cron: "0 9 * * *" })
    expect(newLoadCount).toBe(1)
  })

  it("fails clearly when updating an unknown schedule", async () => {
    await expect(schedules.update("missing", { enabled: false })).rejects.toBeInstanceOf(ScheduleError)
    await expect(schedules.update("missing", { enabled: false })).rejects.toMatchObject({
      code: "SCHEDULE_NOT_FOUND",
    })
  })
})
