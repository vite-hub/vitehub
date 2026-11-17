import { describe, expect, it } from "vitest"

import { scheduleErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createMemoryScheduleRunStore } from "../src/runtime.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { normalizeScheduleRuntimeError } from "../src/runtime/static.ts"

/** The runtime codes that Schedule output, runtimes, and run stores can raise. */
const runtimeCodes = [
  "SCHEDULE_R0003", "SCHEDULE_R0004", "SCHEDULE_R0005", "SCHEDULE_R0006", "SCHEDULE_R0022",
  "SCHEDULE_R0023", "SCHEDULE_R0024", "SCHEDULE_R0025", "SCHEDULE_R0026", "SCHEDULE_R0027",
  "SCHEDULE_R0028", "SCHEDULE_R0030", "SCHEDULE_R0031", "SCHEDULE_R0032", "SCHEDULE_R0033",
  "SCHEDULE_R0034", "SCHEDULE_R0035",
] as const

describe("Schedule runtime error fixes", () => {
  it.each(runtimeCodes)("gives %s a fix and its own docs page", (code) => {
    const error = scheduleErrorDiagnostics[code]({ message: "m" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/schedule/diagnostics/${code.toLowerCase()}`)
  })

  it("names the runtime option of an invalid lease", async () => {
    await expect(installProcessScheduleRuntime({ leaseTtlMs: -1 } as never)).rejects.toMatchObject({
      code: "SCHEDULE_R0024",
      fix: expect.stringContaining("`runtime.leaseTtlMs`"),
    })
  })

  it("points a second createRun() with the same id at getRun()", async () => {
    const store = createMemoryScheduleRunStore()
    const now = new Date()
    const run = { attemptCount: 0, createdAt: now, id: "srun_1", scheduleId: "daily", scheduledAt: now, status: "pending" as const, target: "daily", updatedAt: now }
    await store.createRun(run)
    await expect(async () => await store.createRun(run)).rejects.toMatchObject({
      code: "SCHEDULE_R0031",
      fix: expect.stringContaining("`getRun(id)`"),
    })
  })

  it("tells the author of a handler that throws a non-Error to read error.cause", () => {
    expect(normalizeScheduleRuntimeError("boom")).toMatchObject({
      cause: "boom",
      code: "SCHEDULE_R0035",
      fix: expect.stringContaining("`error.cause`"),
    })
  })
})
