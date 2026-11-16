import { execFileSync } from "node:child_process"

import { describe, expect, it } from "vitest"

import { parseCronFields, timesOfDay } from "../src/os/cron.ts"
import { launchdIntervals, nextLaunchdRun } from "../src/os/launchd.ts"
import { systemdCalendars } from "../src/os/systemd.ts"
import { taskTriggers } from "../src/os/task-scheduler.ts"
import { clockChanges, machineCronFields } from "../src/os/time-zone.ts"
import { isScheduleDue, timeZoneOffsetMinutes } from "../src/runtime/due.ts"

import type { CronFields } from "../src/os/cron.ts"
import type { CalendarInterval } from "../src/os/launchd.ts"
import type { DaySchedule, TaskTriggers } from "../src/os/task-scheduler.ts"
import type { ClockChange } from "../src/os/time-zone.ts"

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

function seconds(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration)!
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
}

/** The minutes of the day where the triggers start a run, as Task Scheduler repeats them inside the duration. */
function taskTimes(triggers: TaskTriggers): number[] {
  const times = new Set<number>()
  for (const trigger of triggers.times) {
    times.add(trigger.start)
    if (!trigger.repetition) continue
    const interval = seconds(trigger.repetition.interval)
    // A repetition without a duration runs on through the day.
    const duration = trigger.repetition.duration ? seconds(trigger.repetition.duration) : 24 * 3600 - trigger.start * 60
    for (let offset = interval; offset < duration; offset += interval) times.add(trigger.start + offset / 60)
  }
  return [...times].sort((left, right) => left - right)
}

const dayMs = 24 * 60 * minuteMs

/** `2027-03-28T02:30`: the wall clock of `time` in `timeZone`. */
function wallClock(time: number, timeZone: string): string {
  return new Date(time + timeZoneOffsetMinutes(new Date(time), timeZone) * minuteMs).toISOString().slice(0, 16)
}

function onCronDay(cron: CronFields, date: Date): boolean {
  const day = cron.days.includes(date.getUTCDate())
  const weekday = cron.weekdays.includes(date.getUTCDay())
  const restricted = cron.days.length !== 31 && cron.weekdays.length !== 7
  return cron.months.includes(date.getUTCMonth() + 1) && (restricted ? day || weekday : day && weekday)
}

function onTaskDay(schedule: DaySchedule, date: Date): boolean {
  if (schedule.kind === "week") return schedule.weekdays.includes(date.getUTCDay())
  if (schedule.kind === "month") return schedule.days.includes(date.getUTCDate()) && schedule.months.includes(date.getUTCMonth() + 1)
  return true
}

/**
 * Wall-clock runs in `timeZone` on the local days before, of, and after `change`. `expected` has each time of the cron
 * that exists on the clock. `runs` has the starts of the triggers when Task Scheduler repeats a trigger in elapsed time,
 * and a start in the hour that the clocks skip does not run.
 */
function aroundChange(cron: CronFields, triggers: TaskTriggers, timeZone: string, change: ClockChange): { expected: string[], runs: string[] } {
  const day = Date.UTC(change.year, change.month - 1, change.day)
  const dates = [day - dayMs, day, day + dayMs].map(date => new Date(date).toISOString().slice(0, 10))
  const inRange = (wall: string) => dates.includes(wall.slice(0, 10))
  // The first instant of each wall-clock minute. A repeated minute keeps its first instant.
  const first = new Map<string, number>()
  for (let time = day - 3 * dayMs; time < day + 3 * dayMs; time += minuteMs) {
    const wall = wallClock(time, timeZone)
    if (!first.has(wall)) first.set(wall, time)
  }
  const expected = [...first.keys()].filter((wall) => {
    const date = new Date(`${wall}Z`)
    return inRange(wall) && onCronDay(cron, date) && cron.hours.includes(date.getUTCHours()) && cron.minutes.includes(date.getUTCMinutes())
  })
  // A day that matches the weekday trigger and the day-of-month trigger starts both at the same instant: one run.
  const instants = new Set<number>()
  for (const schedule of triggers.days) {
    for (const trigger of triggers.times) {
      const interval = trigger.repetition ? seconds(trigger.repetition.interval) * 1000 : 0
      const duration = trigger.repetition?.duration ? seconds(trigger.repetition.duration) * 1000 : 6 * dayMs
      const startDays = schedule.kind === "always" ? [day - 2 * dayMs] : [-2, -1, 0, 1].map(offset => day + offset * dayMs)
      for (const startDay of startDays) {
        if (!onTaskDay(schedule, new Date(startDay))) continue
        const start = first.get(`${new Date(startDay).toISOString().slice(0, 10)}T${new Date(trigger.start * minuteMs).toISOString().slice(11, 16)}`)
        if (start === undefined) continue
        instants.add(start)
        for (let offset = interval; interval && offset < duration; offset += interval) instants.add(start + offset)
      }
    }
  }
  return { expected, runs: [...instants].sort((left, right) => left - right).map(time => wallClock(time, timeZone)).filter(inRange) }
}

function machineTriggers(cron: string, timeZone: string): TaskTriggers | string {
  return taskTriggers(fields(cron), { timeZone, changes: clockChanges(timeZone, base) })
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

describe("clockChanges()", () => {
  it("finds the skipped and the repeated hour of each change in two years", () => {
    const madrid = clockChanges("Europe/Madrid", base)
    expect(madrid).toHaveLength(4)
    expect(madrid.slice(0, 2)).toEqual([
      { year: 2027, month: 3, day: 28, weekday: 0, start: 120, end: 180, delta: 60 },
      { year: 2027, month: 10, day: 31, weekday: 0, start: 120, end: 180, delta: -60 },
    ])
    // Los Angeles goes back from 02:00 to 01:00.
    expect(clockChanges("America/Los_Angeles", base)[1]).toEqual({ year: 2027, month: 11, day: 7, weekday: 0, start: 60, end: 120, delta: -60 })
    expect(clockChanges("UTC", base)).toEqual([])
  })
})

describe("Task Scheduler across the clock changes of the machine zone", () => {
  const madrid = "Europe/Madrid"

  it("splits a repetition that a clock change would move", () => {
    // The reviewer's case: one trigger every 6 hours ran at 00:00, 07:00, 13:00 and 19:00 on the spring Sunday.
    expect(machineTriggers("0 0,6,12,18 * * 0", "America/Los_Angeles")).toEqual({ times: [{ start: 0 }, { start: 360 }, { start: 720 }, { start: 1080 }], days: [{ kind: "week", weekdays: [0] }] })
    expect(machineTriggers("0 */6 * * *", madrid)).toEqual({ times: [{ start: 0 }, { start: 360 }, { start: 720 }, { start: 1080 }], days: [{ kind: "day" }] })
  })

  it("keeps one trigger when no clock change falls between its runs", () => {
    expect(machineTriggers("0 9,10,11 * * *", madrid)).toEqual({ times: [{ start: 540, repetition: { interval: "PT1H", duration: "PT2H30M" } }], days: [{ kind: "day" }] })
    // Madrid changes the clocks on Sundays.
    expect(machineTriggers("* * * * 1-5", madrid)).toEqual(taskTriggers(fields("* * * * 1-5")))
  })

  it("repeats an all-day cron without end when its gap divides the change", () => {
    expect(machineTriggers("*/15 * * * *", madrid)).toEqual({ times: [{ start: 0, repetition: { interval: "PT15M" } }], days: [{ kind: "always" }] })
    // Lord Howe moves its clocks by 30 minutes, so an hourly cron needs one trigger per hour.
    expect(machineTriggers("*/30 * * * *", "Australia/Lord_Howe")).toEqual({ times: [{ start: 0, repetition: { interval: "PT30M" } }], days: [{ kind: "always" }] })
    expect((machineTriggers("0 * * * *", "Australia/Lord_Howe") as TaskTriggers).times).toHaveLength(24)
  })

  it("runs the repeated hour twice with an all-day repetition, and once with a split trigger", () => {
    const [, autumn] = clockChanges(madrid, base)
    const repeated = (cron: string) => aroundChange(fields(cron), machineTriggers(cron, madrid) as TaskTriggers, madrid, autumn!).runs.filter(run => run === "2027-10-31T02:00")
    expect(repeated("*/15 * * * *")).toHaveLength(2)
    expect(repeated("*/15 0-5 * * *")).toHaveLength(1)
  })

  it("splits only the hour that a change crosses", () => {
    const triggers = machineTriggers("*/15 0-5 * * *", madrid) as TaskTriggers
    expect(triggers.times).toHaveLength(9)
    expect(taskTimes(triggers)).toEqual(timesOfDay(fields("*/15 0-5 * * *")))
  })

  it("keeps the output of a machine zone without clock changes", () => {
    for (const cron of ["* * * * *", "*/15 9-17 * * 1-5", "0 0,6,12,18 * * 0", "5,7,40 */6 * * *"]) expect(machineTriggers(cron, "UTC")).toEqual(taskTriggers(fields(cron)))
  })

  it("names the clock change when the split needs more than 48 triggers", () => {
    expect(taskTriggers(fields("* 0-5 * * *"))).not.toBeTypeOf("string")
    expect(machineTriggers("* 0-5 * * *", madrid)).toBe("the clocks in Europe/Madrid change from 02:00 to 03:00 on 2027-03-28, and Task Scheduler repeats a trigger in elapsed time, so the cron needs 65 triggers to keep its times. The limit is 48. Use fewer times of day, or times away from the clock change.")
  })

  it("drifted before: one repetition every 6 hours runs at 07:00 after the spring change", () => {
    const [spring] = clockChanges("America/Los_Angeles", base)
    const { runs } = aroundChange(fields("0 0,6,12,18 * * 0"), taskTriggers(fields("0 0,6,12,18 * * 0")) as TaskTriggers, "America/Los_Angeles", spring!)
    expect(runs).toEqual(["2027-03-14T00:00", "2027-03-14T07:00", "2027-03-14T13:00", "2027-03-14T19:00"])
  })

  const zones = [madrid, "America/Los_Angeles", "Australia/Lord_Howe", "America/Santiago"]
  const crons = ["0 0,6,12,18 * * 0", "*/15 * * * *", "* * * * *", "0 */6 * * *", "0 */2 * * *", "0 * * * *", "*/30 * * * *", "0 9,10,11 * * *", "*/15 0-5 * * *", "*/20 * * * 1-5", "30 1-3 * * *", "0,30 0-3 1 * 0"]
  it.each(zones.flatMap(zone => crons.map(cron => [cron, zone])))("starts %s in %s at its wall-clock times around each clock change", (cron, zone) => {
    const triggers = machineTriggers(cron, zone)
    if (typeof triggers === "string") throw new Error(triggers)
    for (const change of clockChanges(zone, base)) {
      const { expected, runs } = aroundChange(fields(cron), triggers, zone, change)
      // An all-day repetition runs the repeated hour twice; every other trigger runs it once.
      expect([...new Set(runs)]).toEqual(expected)
      if (triggers.days[0]?.kind !== "always") expect(runs).toEqual(expected)
    }
  })
})
