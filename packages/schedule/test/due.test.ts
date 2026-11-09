import { describe, expect, it } from "vitest"

import { isScheduleDue, latestCronMinute, timeZoneOffsetMinutes } from "../src/runtime/due.ts"

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

  it("runs a local time that the spring-forward day skips once, shifted by the gap", () => {
    // Madrid moves from 02:00 CET to 03:00 CEST at 01:00Z, so 02:30 does not occur on 2026-03-29. It runs at 03:30 CEST.
    const missing = schedule("30 2 * * *", "Europe/Madrid")
    expect(dueMinutes(missing, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual(["2026-03-29T01:30:00.000Z"])
    expect(nextDueMinute(missing, "2026-03-28T02:00:00Z")).toEqual(new Date("2026-03-29T01:30:00Z"))
    expect(nextDueMinute(missing, "2026-03-29T01:30:00Z")).toEqual(new Date("2026-03-30T00:30:00Z"))
  })

  it("runs every minute of a skipped hour once when the cron names that hour", () => {
    const minutes = schedule("0,59 2 * * *", "Europe/Madrid")
    expect(dueMinutes(minutes, "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z")).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T01:59:00.000Z"])
  })

  it("does not run a wildcard-hour cron twice in the hour after a skipped hour", () => {
    const hourly = schedule("30 * * * *", "Europe/Madrid")
    expect(dueMinutes(hourly, "2026-03-29T00:00:00Z", "2026-03-29T03:00:00Z")).toEqual(["2026-03-29T00:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-29T02:30:00.000Z"])
  })

  it("follows both transitions in New York", () => {
    // New York moves from 02:00 EST to 03:00 EDT at 07:00Z on 2026-03-08, and from 02:00 EDT to 01:00 EST at 06:00Z on 2026-11-01.
    const skipped = schedule("30 2 * * *", "America/New_York")
    expect(dueMinutes(skipped, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z")).toEqual(["2026-03-08T07:30:00.000Z"])
    const repeated = schedule("30 1 * * *", "America/New_York")
    expect(dueMinutes(repeated, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")).toEqual(["2026-11-01T05:30:00.000Z"])
    const morning = schedule("0 9 * * 1-5", "America/New_York")
    expect(dueMinutes(morning, "2026-03-06T00:00:00Z", "2026-03-10T00:00:00Z")).toEqual(["2026-03-06T14:00:00.000Z", "2026-03-09T13:00:00.000Z"])
  })

  it("follows a 30-minute daylight saving time shift in Lord Howe", () => {
    // Lord Howe moves from 02:00 +10:30 to 02:30 +11:00 at 15:30Z on 2026-10-03, and from 02:00 +11:00 back to
    // 01:30 +10:30 at 15:00Z on 2026-04-04, so 01:45 occurs at 14:45Z and again at 15:15Z.
    const skipped = schedule("15 2 * * *", "Australia/Lord_Howe")
    expect(dueMinutes(skipped, "2026-10-03T12:00:00Z", "2026-10-04T12:00:00Z")).toEqual(["2026-10-03T15:45:00.000Z"])
    const repeated = schedule("45 1 * * *", "Australia/Lord_Howe")
    expect(dueMinutes(repeated, "2026-04-04T12:00:00Z", "2026-04-05T12:00:00Z")).toEqual(["2026-04-04T14:45:00.000Z"])
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

describe("time zone offsets and cron minutes", () => {
  it("reads the offset of a time zone at an instant", () => {
    expect(timeZoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "Europe/Madrid")).toBe(120)
    expect(timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Europe/Madrid")).toBe(60)
    expect(timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "Asia/Kathmandu")).toBe(345)
    expect(timeZoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300)
  })

  it("finds the cron minute of a late wake", () => {
    expect(latestCronMinute("0 6,7 * * *", new Date("2026-07-15T07:41:12.345Z"))).toEqual(new Date("2026-07-15T07:00:00Z"))
    expect(latestCronMinute("0 6,7 * * *", new Date("2026-07-15T06:00:00Z"))).toEqual(new Date("2026-07-15T06:00:00Z"))
    expect(latestCronMinute("*/15 * * * *", new Date("2026-07-15T06:14:59Z"))).toEqual(new Date("2026-07-15T06:00:00Z"))
  })

  it("keeps the current minute when the cron has no minute in the last day", () => {
    expect(latestCronMinute("0 0 1 1 *", new Date("2026-07-15T07:41:12Z"))).toEqual(new Date("2026-07-15T07:41:00Z"))
  })
})
