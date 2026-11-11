import { describe, expect, it } from "vitest"

import { timeZoneOffsets, utcCronForTimeZone } from "../src/internal/time-zone-cron.ts"
import { isScheduleDue } from "../src/runtime/due.ts"
import { isTimeZoneWakeDue } from "../src/runtime/static.ts"

const minuteMs = 60_000
const builtAt = new Date("2026-01-10T00:00:00Z")

describe("UTC cron for a time zone", () => {
  it("lists the offsets of the next two years", () => {
    expect(timeZoneOffsets("Europe/Madrid", builtAt)).toEqual([60, 120])
    expect(timeZoneOffsets("Asia/Kolkata", builtAt)).toEqual([330])
    expect(timeZoneOffsets("Australia/Lord_Howe", builtAt)).toEqual([630, 660])
  })

  it.each([
    ["0 8 * * *", "Europe/Madrid", "0 6,7 * * *"],
    ["30 2 * * *", "Europe/Madrid", "30 0,1 * * *"],
    ["0 7 * * *", "Europe/Stockholm", "0 5,6 * * *"],
    ["0 0 1 * *", "America/New_York", "0 4,5 1 * *"],
    ["0 20 * * 1", "America/Los_Angeles", "0 3,4 * * 2"],
    ["0 9 * * 1-5", "Australia/Sydney", "0 22,23 * * 0,1,2,3,4"],
    ["0 8 * * *", "Asia/Kolkata", "30 2 * * *"],
    ["*/15 * * * *", "Asia/Kathmandu", "*/15 * * * *"],
    ["0 8 * * *", "Australia/Lord_Howe", "0,30 21 * * *"],
    ["0 23,1 * * 3", "Europe/Madrid", "0 0,21,22,23 * * *"],
  ])("runs %s in %s as %s", (cron, timeZone, utcCron) => {
    expect(utcCronForTimeZone(cron, timeZone, builtAt)).toBe(utcCron)
  })

  it("needs no UTC cron for a time zone that is always UTC", () => {
    expect(utcCronForTimeZone("0 3 * * *", "Etc/UTC", builtAt)).toBeUndefined()
  })
})

/** The minutes where the cron is due in its time zone, checked every minute, as the Process Runtime does. */
function processRuns(cron: string, timeZone: string, from: string, to: string): string[] {
  const record = { cron, id: "check", timeZone }
  const runs: string[] = []
  for (let time = Date.parse(from); time < Date.parse(to); time += minuteMs) {
    if (isScheduleDue(record, new Date(time))) runs.push(new Date(time).toISOString())
  }
  return runs
}

/** The minutes where a UTC-only host wakes the Schedule on its UTC cron and the wake is due in the time zone. */
function hostRuns(cron: string, timeZone: string, from: string, to: string): string[] {
  const utcCron = utcCronForTimeZone(cron, timeZone, builtAt)!
  const trigger = { cron: utcCron, id: "trigger" }
  const definition = { cron, handler: () => {}, timeZone }
  const runs: string[] = []
  for (let time = Date.parse(from); time < Date.parse(to); time += minuteMs) {
    const wake = new Date(time)
    if (isScheduleDue(trigger, wake) && isTimeZoneWakeDue(definition, "check", wake)) runs.push(wake.toISOString())
  }
  return runs
}

describe("time-zoned Schedules on a UTC-only host", () => {
  it.each([
    // Madrid: spring forward at 01:00Z on 2026-03-29, fall back at 01:00Z on 2026-10-25.
    ["30 2 * * *", "Europe/Madrid", "2026-03-27T00:00:00Z", "2026-03-31T00:00:00Z", ["2026-03-27T01:30:00.000Z", "2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"]],
    ["30 2 * * *", "Europe/Madrid", "2026-10-24T00:00:00Z", "2026-10-27T00:00:00Z", ["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]],
    ["0 8 * * *", "Europe/Madrid", "2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z", ["2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z"]],
    // New York: spring forward at 07:00Z on 2026-03-08, fall back at 06:00Z on 2026-11-01.
    ["30 2 * * *", "America/New_York", "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z", ["2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]],
    ["30 1 * * *", "America/New_York", "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z", ["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]],
    // Sydney: weekday mornings move to the UTC day before, and the offset changes on 2026-04-05 and 2026-10-04.
    ["0 9 * * 1-5", "Australia/Sydney", "2026-04-02T00:00:00Z", "2026-04-08T00:00:00Z", ["2026-04-02T22:00:00.000Z", "2026-04-05T23:00:00.000Z", "2026-04-06T23:00:00.000Z", "2026-04-07T23:00:00.000Z"]],
    ["30 2 * * *", "Australia/Sydney", "2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", ["2026-10-02T16:30:00.000Z", "2026-10-03T16:30:00.000Z", "2026-10-04T15:30:00.000Z"]],
    // Lord Howe moves by 30 minutes.
    ["45 1 * * *", "Australia/Lord_Howe", "2026-04-03T12:00:00Z", "2026-04-06T12:00:00Z", ["2026-04-03T14:45:00.000Z", "2026-04-04T14:45:00.000Z", "2026-04-05T15:15:00.000Z"]],
  ])("runs %s in %s once per local day, like the Process Runtime", (cron, timeZone, from, to, expected) => {
    expect(hostRuns(cron, timeZone, from, to)).toEqual(expected)
    expect(processRuns(cron, timeZone, from, to)).toEqual(expected)
  })
})
