import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule, runSchedule } from "../src/index.ts"
import { getScheduleRunStore, resetScheduleRuntime } from "../src/runtime/state.ts"

const handler = vi.hoisted(() => vi.fn())

vi.mock("#vitehub/schedule/registry", async () => {
  const { defineSchedule } = await import("../src/definition.ts")
  return {
    default: {
      cron: async () => ({ default: defineSchedule({ cron: "0 9 * * *", handler: () => {} }) }),
      invalid: async () => ({ default: defineSchedule({ cron: "0 9 * * *", handler, manual: true, timeZone: "Not/AZone" }) }),
      report: async () => ({ default: defineSchedule({ cron: "0 9 * * *", handler, manual: true }) }),
    },
  }
})

afterEach(() => {
  handler.mockReset()
  resetScheduleRuntime()
})

describe("runSchedule() from the Schedule root", () => {
  it("runs a manual Definition of the generated registry without a registry argument", async () => {
    const [error, run] = await runSchedule("report", { scheduledAt: "2026-01-31T23:59:00Z" })

    expect(error).toBeUndefined()
    if (error) throw error
    expect(run).toMatchObject({ scheduleId: "report", status: "succeeded" })
    expect(run.scheduledAt.toISOString()).toBe("2026-01-31T23:59:00.000Z")
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: new Date("2026-01-31T23:59:00Z") }))
    expect(await getScheduleRunStore().getRun(run.id)).toEqual(run)
  })

  it("rejects names outside the generated registry and Definitions without manual: true", async () => {
    await expect(runSchedule("missing")).rejects.toMatchObject({ code: "SCHEDULE_DEFINITION_NOT_FOUND" })
    await expect(runSchedule("cron")).rejects.toMatchObject({ code: "SCHEDULE_MANUAL_RUN_DISABLED" })
    // @ts-expect-error The registry is no longer an option.
    await runSchedule("report", { registry: {} })
    expect(handler).toHaveBeenCalledOnce()
  })

  it("returns a failed handler as a failed run, not as an error", async () => {
    handler.mockRejectedValueOnce(new Error("report failed"))

    const [error, run] = await runSchedule("report")

    expect(error).toBeUndefined()
    expect(run).toMatchObject({ scheduleId: "report", status: "failed" })
  })

  it("throws a diagnostic from a lazy Definition before accessing the store", async () => {
    const getRun = vi.spyOn(getScheduleRunStore(), "getRun")
    await expect(runSchedule("invalid")).rejects.toMatchObject({ code: "SCHEDULE_C0006" })
    expect(getRun).not.toHaveBeenCalled()
  })

  it("returns the store failure if writing completion fails after the handler runs", async () => {
    const cause = new Error("completion write failed")
    const updateAttempt = vi.spyOn(getScheduleRunStore(), "updateAttempt").mockRejectedValueOnce(cause)
    expect(await runSchedule("report")).toMatchObject([{ cause, code: "SCHEDULE_RUN_STORE_FAILED" }, undefined])
    expect(handler).toHaveBeenCalledOnce()
    expect(updateAttempt).toHaveBeenCalledOnce()
  })

  it("returns an invalid scheduledAt and a failed run store as errors", async () => {
    expect(await runSchedule("report", { scheduledAt: "2026-01-31" })).toMatchObject([{ code: "SCHEDULE_INVALID_SCHEDULED_AT" }, undefined])

    const cause = new Error("KV unavailable")
    vi.spyOn(getScheduleRunStore(), "createRun").mockRejectedValueOnce(cause)
    expect(await runSchedule("report")).toMatchObject([{ cause, code: "SCHEDULE_RUN_STORE_FAILED" }, undefined])
    expect(handler).not.toHaveBeenCalled()
  })

  it("keeps defineSchedule() in the same root", () => {
    expect(defineSchedule({ cron: "0 9 * * *", handler: () => {} })).toMatchObject({ cron: "0 9 * * *" })
  })
})
