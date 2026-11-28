import { expect, it } from "vitest"

import { scheduleErrorDiagnostics } from "../src/error-diagnostics.ts"
import { runScheduleNow } from "../src/runtime/operations.ts"

const codes = {
  SCHEDULE_DEFINITION_NOT_FOUND: scheduleErrorDiagnostics.SCHEDULE_DEFINITION_NOT_FOUND(),
  SCHEDULE_OPERATION_FAILED: scheduleErrorDiagnostics.SCHEDULE_OPERATION_FAILED(),
  SCHEDULE_RUN_NOT_FOUND: scheduleErrorDiagnostics.SCHEDULE_RUN_NOT_FOUND(),
}

it("gives each code that replaced an error class a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/schedule/diagnostics/${code.toLowerCase()}`)
  }
})

it("gives a name that this server does not know SCHEDULE_DEFINITION_NOT_FOUND with status 404 and a fix", async () => {
  await expect(runScheduleNow({ name: "report" }, {})).rejects.toMatchObject({
    code: "SCHEDULE_DEFINITION_NOT_FOUND",
    fix: expect.stringContaining("manual: true"),
    status: 404,
  })
})
