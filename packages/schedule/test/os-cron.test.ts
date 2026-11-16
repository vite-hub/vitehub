import { execFileSync } from "node:child_process"

import { describe, expect, it } from "vitest"

import { parseCronFields, timesOfDay } from "../src/os/cron.ts"
import { launchdIntervals, nextLaunchdRun } from "../src/os/launchd.ts"
import { systemdCalendars } from "../src/os/systemd.ts"
import { taskTriggers } from "../src/os/task-scheduler.ts"
import { machineCronFields } from "../src/os/time-zone.ts"
import { isScheduleDue } from "../src/runtime/due.ts"

import type { CronFields } from "../src/os/cron.ts"
import type { CalendarInterval } from "../src/os/launchd.ts"
import type { TaskTriggers } from "../src/os/task-scheduler.ts"

const minuteMs = 60_000
// Far from any daylight saving change, so the runs below do not depend on how an OS handles a skipped or repeated hour.
const base = new Date("2027-01-04T00:00:00Z")
const systemdAnalyze = (() => {
  try {
    execFileSync("systemd-analyze", ["--version"], { stdio: "ignore" })
    return true
  }
  catch {
    return false
  }
})()

function fields(cron: string): CronFields {
  const parsed = parseCronFields(cron)
  if (!parsed) throw new Error(`invalid cron ${cron}`)
  return parsed
}

/** The first `count` runs after `from` that the ViteHub runtime gives the cron in `timeZone`. */
function runtimeRuns(cron: string, timeZone: string, count: number, from = base): string[] {
  const record = { cron, id: "check", timeZone }
  const runs: string[] = []
  for (let time = from.getTime() + minuteMs; runs.length < count; time += minuteMs) {
    if (isScheduleDue(record, new Date(time))) runs.push(new Date(time).toISOString())
  }
  return runs
}

/** The first `count` runs after `base` that `systemd-analyze calendar` gives the `OnCalendar=` lines. */
function systemdRuns(calendars: readonly string[], count: number): string[] {
  const output = execFileSync("systemd-analyze", ["calendar", `--base-time=${base.toISOString().replace("T", " ").slice(0, 19)} UTC`, `--iterations=${count}`, ...calendars], { encoding: "utf8", env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" } })
  const runs = [...output.matchAll(/(?:Next elapse|Iteration #\d+): \w{3} (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/g)].map(match => new Date(`${match[1]!.replace(" ", "T")}Z`).toISOString())
  return [...new Set(runs)].sort().slice(0, count)
}

/** The first `count` runs after `base` of launchd dicts in the machine zone. */
function launchdRuns(intervals: readonly CalendarInterval[], machineTimeZone: string, count: number): string[] {
  const runs: string[] = []
  for (let at = base; runs.length < count;) {
    const next = nextLaunchdRun(intervals, machineTimeZone, at)
    if (!next) break
    runs.push(next.toISOString())
    at = next
  }
  return runs
}

/** The minutes of the day where the triggers start a run, as Task Scheduler repeats them inside the duration. */
function taskTimes(triggers: TaskTriggers): number[] {
  const seconds = (duration: string) => {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration)!
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  }
  const times = new Set<number>()
  for (const trigger of triggers.times) {
    times.add(trigger.start)
    if (!trigger.repetition) continue
    const interval = seconds(trigger.repetition.interval)
    for (let offset = interval; offset < seconds(trigger.repetition.duration); offset += interval) times.add(trigger.start + offset / 60)
  }
  return [...times].sort((left, right) => left - right)
}

describe("parseCronFields()", () => {
  it("reads the five fields, with months 1 to 12 and Sunday 0", () => {
    expect(parseCronFields("5 4 1,15 jan-mar 7")).toEqual({ minutes: [5], hours: [4], days: [1, 15], months: [1, 2, 3], weekdays: [0] })
  })

  it.each(["0 0 * * * *", "0 0 L * *", " 0 0 * * *", "every hour"])("rejects %j", (cron) => {
    expect(parseCronFields(cron)).toBeUndefined()
  })
})

describe("systemd", () => {
  it.each([
    ["* * * * *", "UTC", ["*-*-* *:*:00 UTC"]],
    ["0 9 * * 1-5", "Europe/Madrid", ["Mon..Fri *-*-* 09:00:00 Europe/Madrid"]],
    ["*/15 9-17 * * *", "UTC", ["*-*-* 09..17:00,15,30,45:00 UTC"]],
    ["5 4 1-5 1-3 *", "UTC", ["*-01..03-01..05 04:05:00 UTC"]],
    ["0 0 * * 0,6", "UTC", ["Sat,Sun *-*-* 00:00:00 UTC"]],
    ["0 0 * 2 7", "UTC", ["Sun *-02-* 00:00:00 UTC"]],
    // cron runs on the 1st or the 15th, and on every Sunday.
    ["30 6 1,15 * 0", "America/New_York", ["Sun *-*-* 06:30:00 America/New_York", "*-*-01,15 06:30:00 America/New_York"]],
  ])("writes %s in %s as OnCalendar=%j", (cron, timeZone, calendars) => {
    expect(systemdCalendars(fields(cron), timeZone)).toEqual(calendars)
  })

  it.skipIf(!systemdAnalyze).each([
    ["0 9 * * 1-5", "Europe/Madrid", 12],
    ["*/15 9-17 * * *", "UTC", 12],
    ["30 6 1,15 * 0", "America/New_York", 12],
    ["0 0 * 2 7", "Asia/Kolkata", 4],
    ["0 12 29,31 * *", "UTC", 6],
    ["7,8,9,40 3,5 * * 2,4", "Australia/Sydney", 12],
  ])("gives the runs of the ViteHub runtime for %s in %s (systemd-analyze calendar)", (cron, timeZone, count) => {
    expect(systemdRuns(systemdCalendars(fields(cron), timeZone), count)).toEqual(runtimeRuns(cron, timeZone, count))
  }, 30_000)
})

describe("launchd", () => {
  it.each([
    ["* * * * *", [{}]],
    ["0 * * * *", [{ Minute: 0 }]],
    ["0 9 * * 1-5", [1, 2, 3, 4, 5].map(Weekday => ({ Minute: 0, Hour: 9, Weekday }))],
    ["0,30 9 1 3 *", [{ Minute: 0, Hour: 9, Day: 1, Month: 3 }, { Minute: 30, Hour: 9, Day: 1, Month: 3 }]],
    // One dict set for the day of the month and one for the weekday, since cron ORs them.
    ["0 9 1 * 1", [{ Minute: 0, Hour: 9, Day: 1 }, { Minute: 0, Hour: 9, Weekday: 1 }]],
  ])("writes %s as %j", (cron, intervals) => {
    expect(launchdIntervals(fields(cron))).toEqual(intervals)
  })

  it("rejects a cron that needs more than 1000 dicts", () => {
    expect(launchdIntervals(fields("0-58 0-22 * * *"))).toBe("it needs 1357 StartCalendarInterval entries, and the limit is 1000.")
  })

  it.each([
    ["0 9 * * 1-5", "Europe/Madrid", "Europe/Madrid"],
    ["*/20 * 1,15 * 0", "UTC", "UTC"],
    ["0 * * * *", "Europe/Madrid", "UTC"],
    ["0 23 * * 1", "UTC", "Etc/GMT-2"],
    ["0 9 * * *", "Asia/Kolkata", "UTC"],
  ])("gives the runs of the ViteHub runtime for %s in %s on a machine in %s", (cron, timeZone, machineTimeZone) => {
    const machine = machineCronFields(fields(cron), timeZone, machineTimeZone, base)!
    const intervals = launchdIntervals(machine)
    if (typeof intervals === "string") throw new Error(intervals)
    expect(launchdRuns(intervals, machineTimeZone, 10)).toEqual(runtimeRuns(cron, timeZone, 10))
  })
})

describe("Task Scheduler", () => {
  it("repeats every minute from one daily trigger", () => {
    expect(taskTriggers(fields("* * * * *"))).toEqual({
      times: [{ start: 0, repetition: { interval: "PT1M", duration: "PT23H59M30S" } }],
      days: [{ kind: "day" }],
    })
  })

  it.each([
    ["*/15 9-17 * * 1-5", 1, [{ kind: "week", weekdays: [1, 2, 3, 4, 5] }]],
    ["0 */2 * * *", 1, [{ kind: "day" }]],
    // Minutes 0 and 30 at 9 and 18: one trigger per hour.
    ["0,30 9,18 * * *", 2, [{ kind: "day" }]],
    // Minutes 5, 7, 40 every 6 hours: one trigger per minute.
    ["5,7,40 */6 * * *", 3, [{ kind: "day" }]],
    ["5 4 1,15 1-3 *", 1, [{ kind: "month", days: [1, 15], months: [1, 2, 3] }]],
    ["5 4 * 6 *", 1, [{ kind: "month", days: Array.from({ length: 31 }, (_, index) => index + 1), months: [6] }]],
    ["0 9 1 * 1", 1, [{ kind: "week", weekdays: [1] }, { kind: "month", days: [1], months: Array.from({ length: 12 }, (_, index) => index + 1) }]],
  ])("writes %s as %i time triggers on %j", (cron, timeCount, days) => {
    const triggers = taskTriggers(fields(cron))
    if (typeof triggers === "string") throw new Error(triggers)
    expect(triggers.times).toHaveLength(timeCount)
    expect(triggers.days).toEqual(days)
  })

  it.each(["* * * * *", "*/15 9-17 * * 1-5", "0,30 9,18 * * *", "5,7,40 */6 * * *", "0,7,9 1,2,5,11,13,17,19,23 * * *", "*/7 * * * *", "0 0,1,2,3,7 * * *"])("starts %s at each time of its day", (cron) => {
    const triggers = taskTriggers(fields(cron))
    if (typeof triggers === "string") throw new Error(triggers)
    expect(taskTimes(triggers)).toEqual(timesOfDay(fields(cron)))
  })

  it("rejects a weekday list in some months", () => {
    expect(taskTriggers(fields("0 9 * 1-6 1"))).toBe("a weekly trigger runs in every month, so it cannot keep a weekday list to some months.")
  })

  it("rejects more than 48 triggers", () => {
    expect(taskTriggers(fields("0,7,9 1,2,5,11,13,17,19,23 1 * 1"))).not.toBeTypeOf("string")
    expect(taskTriggers(fields("0,7,9,20 1,2,5,11,13,17,19,23 1 * 1"))).toBe("it needs 64 triggers, and the limit is 48. Use times of day with equal gaps, such as \"*/20 9-17 * * *\".")
  })
})

describe("machineCronFields()", () => {
  it("keeps the cron when the machine has the same zone or the same offsets", () => {
    const cron = fields("0 9 * * 1-5")
    expect(machineCronFields(cron, "Europe/Madrid", "Europe/Madrid", base)).toBe(cron)
    expect(machineCronFields(cron, "Europe/Madrid", "Europe/Paris", base)).toBe(cron)
    expect(machineCronFields(cron, "UTC", "Etc/UTC", base)).toBe(cron)
  })

  it("moves the times by a constant difference", () => {
    // UTC is 2 hours behind Etc/GMT-2 all year.
    expect(machineCronFields(fields("0 9 * * *"), "UTC", "Etc/GMT-2", base)).toEqual(fields("0 11 * * *"))
    // Monday 23:00 UTC is Tuesday 01:00 on the machine.
    expect(machineCronFields(fields("0 23 * * 1"), "UTC", "Etc/GMT-2", base)).toEqual(fields("0 1 * * 2"))
    // Every hour at :00 in Kolkata is every hour at :30 in UTC.
    expect(machineCronFields(fields("0 * * * *"), "Asia/Kolkata", "UTC", base)).toEqual(fields("30 * * * *"))
  })

  it("rejects a shift that moves a day of the month, or that splits the times", () => {
    expect(machineCronFields(fields("0 23 1 * *"), "UTC", "Etc/GMT-2", base)).toBeUndefined()
    // 09:00 and 09:45 in Kolkata are 03:30 and 04:15 in UTC: no hours × minutes product.
    expect(machineCronFields(fields("0,45 9 * * *"), "Asia/Kolkata", "UTC", base)).toBeUndefined()
  })

  it("rejects a daily cron when daylight saving time changes the difference", () => {
    expect(machineCronFields(fields("0 9 * * *"), "Europe/Madrid", "UTC", base)).toBeUndefined()
    expect(machineCronFields(fields("0 9 * * *"), "Asia/Kolkata", "Europe/Madrid", base)).toBeUndefined()
    // Europe and the US change on different dates.
    expect(machineCronFields(fields("0 9 * * *"), "Europe/London", "America/New_York", base)).toBeUndefined()
  })

  it("keeps an hourly cron across whole-hour differences that change", () => {
    expect(machineCronFields(fields("0 * * * *"), "Europe/Madrid", "UTC", base)).toEqual(fields("0 * * * *"))
    expect(machineCronFields(fields("*/15 * * * *"), "America/New_York", "Europe/Madrid", base)).toEqual(fields("*/15 * * * *"))
    // Kolkata is 4:30 and then 3:30 ahead of Madrid: :00 is always :30.
    expect(machineCronFields(fields("0 * * * *"), "Asia/Kolkata", "Europe/Madrid", base)).toEqual(fields("30 * * * *"))
    // An hourly cron on Mondays moves across midnight at a different hour in summer.
    expect(machineCronFields(fields("0 * * * 1"), "Europe/Madrid", "UTC", base)).toBeUndefined()
  })
})
