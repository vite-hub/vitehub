import { afterEach, describe, expect, it } from "vitest"

import { createMemoryScheduleRunStore, executeStaticSchedule, ScheduleError, schedules } from "../src/index.ts"
import { loadScheduleDefinition, resetScheduleRuntime, setScheduleRunStore, setScheduleRuntimeRegistry } from "../src/runtime/state.ts"

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
