import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { executeSchedule, runSchedule } from "../src/runtime.ts"
import { createScheduleError } from "../src/errors.ts"

describe("Schedule errors", () => {
  it("uses the shared ViteHub error contract", () => {
    const cause = new Error("private-provider-cause")
    const error = createScheduleError("SCHEDULE_DEFINITION_NOT_FOUND", { cause, requestId: "request-1" })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "SCHEDULE_DEFINITION_NOT_FOUND",
      message: "Static Schedule Definition was not found.",
      name: "ViteHubError",
      requestId: "request-1",
    })
    expect(JSON.stringify(error)).not.toContain("private-provider-cause")
  })

  it.each([
    [() => runSchedule("private-name-value", { registry: {} }), "SCHEDULE_DEFINITION_NOT_FOUND"],
    [() => executeSchedule({ definition: { cron: "0 9 * * *", handler: () => {} }, scheduleId: "report", scheduledAt: "private-date-value" as never, target: "report" }), "SCHEDULE_INVALID_SCHEDULED_AT"],
  ])("returns ViteHubError code %s", async (run, code) => {
    const error = await Promise.resolve().then(run).then(() => undefined, cause => cause)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({ code, name: "ViteHubError" })
    expect(JSON.stringify(error)).not.toMatch(/private-name-value|private-date-value/)
  })

  it("does not publish a Schedule-specific error constructor", async () => {
    const schedule = await import("../dist/index.js")
    expect(schedule).not.toHaveProperty("ScheduleError")
  })
})
