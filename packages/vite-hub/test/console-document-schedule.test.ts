import { describe, expect, it } from "vitest"

import { consoleDocumentScheduleHint, consoleDocumentScheduleLabel, consoleDocumentScheduleTone, consoleHintParts, consoleLocalScheduleTime, parseConsoleListQuery } from "../src/console/runtime/client/documents.ts"
import { parseConsoleDocumentSetup } from "../src/console/runtime/definitions.ts"

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

  it("names the fix when an overdue schedule has no runner", () => {
    const at = new Date(2026, 9, 20, 9, 0).toISOString()
    const setup = { schedule: { message: "Nothing publishes scheduled documents. Add a Schedule Definition that calls `content.publishDue()`.", docs: "https://vitehub.dev/docs/content/scheduling#run-due-schedules" } }
    expect(consoleDocumentScheduleHint({ at, id: "s", status: "overdue" }, setup, "en-US")).toBe("Was due Oct 20, 2026, 9:00 AM. No run has published it yet. Nothing publishes scheduled documents. Add a Schedule Definition that calls content.publishDue().")
    // With a runner, an overdue schedule means the runner did not fire on this host.
    expect(consoleDocumentScheduleHint({ at, id: "s", status: "overdue" }, {}, "en-US")).toMatch(/No run has published it yet\. Check that the Schedule that publishes scheduled documents runs on this host\.$/)
    expect(consoleDocumentScheduleHint({ at, id: "s", status: "pending" }, setup, "en-US")).toBe("Publishes this draft Oct 20, 2026, 9:00 AM. Saving it again before then makes the schedule fail.")
    expect(consoleDocumentScheduleHint({ at, failure: "A draft changed.", id: "s", status: "failed" }, setup)).toBe("A draft changed. Dismiss it from the menu, then schedule again.")
    expect(consoleHintParts(setup.schedule.message)).toEqual([
      { code: false, text: "Nothing publishes scheduled documents. Add a Schedule Definition that calls " },
      { code: true, text: "content.publishDue()" },
      { code: false, text: "." },
    ])
  })

  it("reads setup hints from untrusted JSON", () => {
    expect(parseConsoleDocumentSetup(undefined)).toBeUndefined()
    expect(parseConsoleDocumentSetup({ access: { message: " " }, schedule: "no" })).toBeUndefined()
    expect(parseConsoleDocumentSetup({ access: { message: "Add `authorize`.", docs: "https://vitehub.dev/docs/content/configure#access" }, other: { message: "x" } }))
      .toEqual({ access: { message: "Add `authorize`.", docs: "https://vitehub.dev/docs/content/configure#access" } })
    // A hint links only to web documentation.
    expect(parseConsoleDocumentSetup({ schedule: { message: "Fix it.", docs: "javascript:alert(1)" } })).toEqual({ schedule: { message: "Fix it." } })
  })

  it("keeps the Scheduled tab in the list URL", () => {
    expect(parseConsoleListQuery({ state: "scheduled" }, { facets: [], sorts: ["id:asc"] }).state).toBe("scheduled")
  })
})
