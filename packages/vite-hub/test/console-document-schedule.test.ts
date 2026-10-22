import { describe, expect, it } from "vitest"

import { consoleDocumentScheduleLabel, consoleDocumentScheduleTone, consoleLocalScheduleTime, parseConsoleListQuery } from "../src/console/runtime/client/documents.ts"

describe("Console document schedules", () => {
  it("labels a schedule with its local time", () => {
    const at = new Date(2026, 9, 20, 9, 0).toISOString()
    expect(consoleDocumentScheduleLabel({ at, id: "s", status: "pending" }, "en-US")).toBe("Scheduled · Oct 20, 09:00")
    expect(consoleDocumentScheduleLabel({ at, id: "s", status: "overdue" }, "en-US")).toBe("Overdue · Oct 20, 09:00")
    expect(consoleDocumentScheduleLabel({ at, failure: "Changed", id: "s", status: "failed" }, "en-US")).toBe("Schedule failed")
    expect(consoleDocumentScheduleTone({ at, id: "s", status: "pending" })).toBe("neutral")
    expect(consoleDocumentScheduleTone({ at, id: "s", status: "overdue" })).toBe("warning")
    expect(consoleDocumentScheduleTone({ at, id: "s", status: "failed" })).toBe("error")
  })

  it("reads a local date and time as one instant", () => {
    expect(consoleLocalScheduleTime("2026-10-20", "09:00")).toBe(new Date(2026, 9, 20, 9, 0).toISOString())
    // `UInputTime` values write seconds.
    expect(consoleLocalScheduleTime("2026-10-20", "09:30:00")).toBe(new Date(2026, 9, 20, 9, 30).toISOString())
    expect(consoleLocalScheduleTime("2026-10-20", "")).toBeUndefined()
    expect(consoleLocalScheduleTime("", "09:00")).toBeUndefined()
  })

  it("keeps the Scheduled tab in the list URL", () => {
    expect(parseConsoleListQuery({ state: "scheduled" }, { facets: [], sorts: ["id:asc"] }).state).toBe("scheduled")
  })
})
