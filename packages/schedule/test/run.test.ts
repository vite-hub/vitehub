import { afterEach, describe, expect, it, vi } from "vitest"

import { defineSchedule, runSchedule } from "../src/index.ts"
import { getScheduleRunStore, resetScheduleRuntime } from "../src/runtime/state.ts"

const handler = vi.hoisted(() => vi.fn())

// The Schedule Vite plugin generates this registry from `server/schedules/`.
vi.mock("#vitehub/schedule/registry", async () => {
  const { defineSchedule } = await import("../src/definition.ts")
  return {
    default: {
      cron: async () => ({ default: defineSchedule({ cron: "0 9 * * *", handler: () => {} }) }),
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
    const run = await runSchedule("report", { scheduledAt: "2026-01-31T23:59:00Z" })

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

  it("keeps defineSchedule() in the same root", () => {
    expect(defineSchedule({ cron: "0 9 * * *", handler: () => {} })).toMatchObject({ cron: "0 9 * * *" })
  })
})
