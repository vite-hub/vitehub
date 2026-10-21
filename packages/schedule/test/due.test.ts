import { describe, expect, it } from "vitest"

import { isRuntimeScheduleDue, nextRuntimeScheduleRunAt } from "../src/runtime/due.ts"

import type { RuntimeScheduleRecord } from "../src/types.ts"

const minuteMs = 60_000

function schedule(cron: string, timeZone?: string): RuntimeScheduleRecord {
  const createdAt = new Date(0)
  return { createdAt, cron, enabled: true, id: "madrid", target: "report", updatedAt: createdAt, ...(timeZone ? { timeZone } : {}) }
}

/** Every due minute from `from` (inclusive) to `to` (exclusive), as ISO strings. */
function dueMinutes(record: RuntimeScheduleRecord, from: string, to: string): string[] {
  const due: string[] = []
  for (let time = Date.parse(from); time < Date.parse(to); time += minuteMs) {
    if (isRuntimeScheduleDue(record, new Date(time))) due.push(new Date(time).toISOString())
  }
  return due
}

describe("cron evaluation in a time zone", () => {
  const daily = schedule("0 8 * * *", "Europe/Madrid")

  it("runs 08:00 in Madrid at 06:00Z in summer and 07:00Z in winter", () => {
    expect(dueMinutes(daily, "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")).toEqual(["2026-07-15T06:00:00.000Z"])
    expect(dueMinutes(daily, "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z")).toEqual(["2026-01-15T07:00:00.000Z"])
  })

  it("runs 08:00 in Madrid once on both 2026 daylight saving time transition days", () => {
    expect(dueMinutes(daily, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual(["2026-03-29T06:00:00.000Z"])
    expect(dueMinutes(daily, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")).toEqual(["2026-10-25T07:00:00.000Z"])
    expect(nextRuntimeScheduleRunAt(daily, new Date("2026-03-28T07:00:00Z"))).toEqual(new Date("2026-03-29T06:00:00Z"))
    expect(nextRuntimeScheduleRunAt(daily, new Date("2026-10-24T06:00:00Z"))).toEqual(new Date("2026-10-25T07:00:00Z"))
  })

  it("skips a local time that does not exist on the spring-forward day", () => {
    // Madrid moves from 02:00 CET to 03:00 CEST at 01:00Z, so 02:30 does not occur on 2026-03-29.
    const missing = schedule("30 2 * * *", "Europe/Madrid")
    expect(dueMinutes(missing, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual([])
    expect(nextRuntimeScheduleRunAt(missing, new Date("2026-03-28T02:00:00Z"))).toEqual(new Date("2026-03-30T00:30:00Z"))
  })

  it("runs a fixed local time once when the fall-back day repeats it", () => {
    // Madrid moves from 03:00 CEST to 02:00 CET at 01:00Z, so 02:30 occurs at 00:30Z and again at 01:30Z.
    const repeated = schedule("30 2 * * *", "Europe/Madrid")
    expect(dueMinutes(repeated, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")).toEqual(["2026-10-25T00:30:00.000Z"])
    expect(nextRuntimeScheduleRunAt(repeated, new Date("2026-10-25T00:30:00Z"))).toEqual(new Date("2026-10-26T01:30:00Z"))
  })

  it("runs a fixed local time once across a historical 23-hour rollback", () => {
    const repeated = schedule("30 1 * * *", "Kwajalein")
    expect(dueMinutes(repeated, "1969-09-30T13:00:00Z", "1969-10-01T00:00:00Z")).toEqual([])
    expect(nextRuntimeScheduleRunAt(repeated, new Date("1969-09-30T12:30:00Z"))).toEqual(new Date("1969-10-01T13:30:00Z"))
  })

  it("runs a cron with a wildcard hour in both occurrences of the repeated hour", () => {
    const hourly = schedule("30 * * * *", "Europe/Madrid")
    expect(dueMinutes(hourly, "2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"])
  })

  it("evaluates UTC and an absent time zone the same way", () => {
    expect(dueMinutes(schedule("0 8 * * *", "UTC"), "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")).toEqual(["2026-07-15T08:00:00.000Z"])
    expect(dueMinutes(schedule("0 8 * * *"), "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")).toEqual(["2026-07-15T08:00:00.000Z"])
  })
})
