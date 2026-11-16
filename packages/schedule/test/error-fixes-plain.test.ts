import { expect, it } from "vitest"

import { scheduleErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives SCHEDULE_DEFINITION_EXPORT_INVALID a fix and its own docs page", () => {
  const error = scheduleErrorDiagnostics.SCHEDULE_DEFINITION_EXPORT_INVALID({ name: "daily-report" })
  expect(error.message).toBe("Schedule \"daily-report\" has no default export of defineSchedule() with a cron and a handler.")
  expect(error.fix).toContain("defineSchedule({ cron, handler })")
  expect(error.docs).toBe("https://vitehub.dev/docs/schedule/diagnostics/schedule_definition_export_invalid")
})
