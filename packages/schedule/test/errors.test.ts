import { ViteHubError } from "@vite-hub/runtime"
import { describe, expect, it } from "vitest"

import { createMemoryRuntimeScheduleStore, schedules, validateRuntimeScheduleCron } from "../src/index.ts"
import { createScheduleError } from "../src/errors.ts"

describe("Schedule errors", () => {
  it("uses the shared ViteHub error contract", () => {
    const cause = new Error("private-provider-cause")
    const error = createScheduleError("SCHEDULE_NOT_FOUND", { cause, requestId: "request-1" })

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error.cause).toBe(cause)
    expect(error.toJSON()).toEqual({
      code: "SCHEDULE_NOT_FOUND",
      message: "Runtime Schedule was not found.",
      name: "ViteHubError",
      requestId: "request-1",
    })
    expect(JSON.stringify(error)).not.toContain("private-provider-cause")
  })

  it.each([
    [() => validateRuntimeScheduleCron("private-cron-value"), "SCHEDULE_INVALID_CRON"],
    [() => schedules.create({ cron: "0 9 * * *", privateSecretField: "secret", target: "report" } as never), "SCHEDULE_INVALID_INPUT"],
    [() => schedules.run({ token: "private-id-value" } as never), "SCHEDULE_INVALID_ID"],
  ])("returns ViteHubError code %s", async (run, code) => {
    const error = await Promise.resolve().then(run).then(() => undefined, cause => cause)
    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({ code, name: "ViteHubError" })
    expect(JSON.stringify(error)).not.toMatch(/private-cron-value|privateSecretField|private-id-value|secret/)
  })

  it("validates ids passed directly to a public store", () => {
    const store = createMemoryRuntimeScheduleStore()
    expect(() => store.create({ id: { token: "private-store-id-value" } } as never)).toThrow(expect.objectContaining({
      code: "SCHEDULE_INVALID_ID",
      name: "ViteHubError",
    }))
  })

  it("does not publish a Schedule-specific error constructor", async () => {
    const schedule = await import("../dist/index.js")
    expect(schedule).not.toHaveProperty("ScheduleError")
  })
})
