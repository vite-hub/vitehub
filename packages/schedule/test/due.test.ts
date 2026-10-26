import { describe, expect, it } from "vitest"

import { isScheduleDue } from "../src/runtime/due.ts"

import type { ScheduleCronRecord } from "../src/runtime/due.ts"

const minuteMs = 60_000

function schedule(cron: string, timeZone?: string): ScheduleCronRecord {
  return { cron, id: "madrid", ...(timeZone ? { timeZone } : {}) }
}

/** Every due minute from `from` (inclusive) to `to` (exclusive), as ISO strings. */
function dueMinutes(record: ScheduleCronRecord, from: string, to: string): string[] {
  const due: string[] = []
  for (let time = Date.parse(from); time < Date.parse(to); time += minuteMs) {
    if (isScheduleDue(record, new Date(time))) due.push(new Date(time).toISOString())
  }
  return due
}

/** The first due minute after `after`, within three days. */
function nextDueMinute(record: ScheduleCronRecord, after: string): Date | undefined {
  for (let time = Date.parse(after) + minuteMs; time <= Date.parse(after) + 3 * 24 * 60 * minuteMs; time += minuteMs) {
    if (isScheduleDue(record, new Date(time))) return new Date(time)
  }
  return undefined
}

describe("cron evaluation in a time zone", () => {
  const daily = schedule("0 8 * * *", "Europe/Madrid")

  it("uses changed expressions on an already evaluated record", () => {
    const record = schedule("* * * * *")
    const minute = new Date("2026-07-15T08:15:00Z")
    expect(isScheduleDue(record, minute)).toBe(true)
    record.cron = "0 * * * *"
    expect(isScheduleDue(record, minute)).toBe(false)
    expect(isScheduleDue(record, new Date("2026-07-15T09:00:00Z"))).toBe(true)
  })

  it.each(["* * * * * *", "invalid * * * *"])("rejects an invalid expression after a valid evaluation: %s", (cron) => {
    const record = schedule("* * * * *")
    const minute = new Date("2026-07-15T08:15:00Z")
    expect(isScheduleDue(record, minute)).toBe(true)
    record.cron = cron
    expect(() => isScheduleDue(record, minute)).toThrow()
    record.cron = "15 * * * *"
    expect(isScheduleDue(record, minute)).toBe(true)
  })

  it("uses changed time zones on an already evaluated record", () => {
    const record = schedule("0 8 * * *", "UTC")
    const minute = new Date("2026-07-15T08:00:00Z")
    expect(isScheduleDue(record, minute)).toBe(true)
    record.timeZone = "Europe/Madrid"
    expect(isScheduleDue(record, minute)).toBe(false)
    expect(isScheduleDue(record, new Date("2026-07-15T06:00:00Z"))).toBe(true)
  })

  it("runs 08:00 in Madrid at 06:00Z in summer and 07:00Z in winter", () => {
    expect(dueMinutes(daily, "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")).toEqual(["2026-07-15T06:00:00.000Z"])
    expect(dueMinutes(daily, "2026-01-15T00:00:00Z", "2026-01-16T00:00:00Z")).toEqual(["2026-01-15T07:00:00.000Z"])
  })

  it("runs 08:00 in Madrid once on both 2026 daylight saving time transition days", () => {
    expect(dueMinutes(daily, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual(["2026-03-29T06:00:00.000Z"])
    expect(dueMinutes(daily, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")).toEqual(["2026-10-25T07:00:00.000Z"])
    expect(nextDueMinute(daily, "2026-03-28T07:00:00Z")).toEqual(new Date("2026-03-29T06:00:00Z"))
    expect(nextDueMinute(daily, "2026-10-24T06:00:00Z")).toEqual(new Date("2026-10-25T07:00:00Z"))
  })

  it("skips a local time that does not exist on the spring-forward day", () => {
    // Madrid moves from 02:00 CET to 03:00 CEST at 01:00Z, so 02:30 does not occur on 2026-03-29.
    const missing = schedule("30 2 * * *", "Europe/Madrid")
    expect(dueMinutes(missing, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual([])
    expect(nextDueMinute(missing, "2026-03-28T02:00:00Z")).toEqual(new Date("2026-03-30T00:30:00Z"))
  })

  it("runs a fixed local time once when the fall-back day repeats it", () => {
    // Madrid moves from 03:00 CEST to 02:00 CET at 01:00Z, so 02:30 occurs at 00:30Z and again at 01:30Z.
    const repeated = schedule("30 2 * * *", "Europe/Madrid")
    expect(dueMinutes(repeated, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z")).toEqual(["2026-10-25T00:30:00.000Z"])
    expect(nextDueMinute(repeated, "2026-10-25T00:30:00Z")).toEqual(new Date("2026-10-26T01:30:00Z"))
  })

  it("runs a fixed local time once across a historical 23-hour rollback", () => {
    const repeated = schedule("30 1 * * *", "Kwajalein")
    expect(dueMinutes(repeated, "1969-09-30T13:00:00Z", "1969-10-01T00:00:00Z")).toEqual([])
    expect(nextDueMinute(repeated, "1969-09-30T12:30:00Z")).toEqual(new Date("1969-10-01T13:30:00Z"))
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
