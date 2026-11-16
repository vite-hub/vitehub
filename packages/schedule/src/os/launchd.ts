import { timeZoneOffsetMinutes } from "../runtime/due.ts"
import { isDayRestricted, isMonthRestricted, isWeekdayRestricted, range } from "./cron.ts"
import { osScheduleErrors } from "./errors.ts"
import { commandOutput, generatedHeader, pathsFor } from "./host.ts"
import { machineFieldsOrError } from "./time-zone.ts"

import type { Result } from "@vite-hub/runtime"
import type { CronFields } from "./cron.ts"
import type { OsScheduleErrorCode, OsScheduleScope } from "./errors.ts"
import type { ExecResult, OsDriver, OsHost, OsScheduleStatus, OsTimerSpec } from "./host.ts"

/** One `StartCalendarInterval` dict. A missing key matches every value. */
export interface CalendarInterval {
  Minute?: number
  Hour?: number
  Day?: number
  Weekday?: number
  Month?: number
}

const intervalKeys = new Set<string>(["Minute", "Hour", "Day", "Weekday", "Month"])
const maxIntervals = 1000
const { join } = pathsFor("darwin")

/**
 * `StartCalendarInterval` dicts for the cron: one per combination of the restricted fields. launchd ANDs the keys of a
 * dict, so a cron that restricts both day fields gets the day dicts and the weekday dicts.
 */
export function launchdIntervals(fields: CronFields): CalendarInterval[] | string {
  const values = (restricted: boolean, list: readonly number[]) => restricted ? list : [undefined]
  const minutes = values(fields.minutes.length !== 60, fields.minutes)
  const hours = values(fields.hours.length !== 24, fields.hours)
  const months = values(isMonthRestricted(fields), fields.months)
  const days: Pick<CalendarInterval, "Day" | "Weekday">[] = [
    ...isDayRestricted(fields) ? fields.days.map(Day => ({ Day })) : [],
    ...isWeekdayRestricted(fields) ? fields.weekdays.map(Weekday => ({ Weekday })) : [],
  ]
  if (!days.length) days.push({})
  const count = minutes.length * hours.length * months.length * days.length
  if (count > maxIntervals) return `it needs ${count} StartCalendarInterval entries, and the limit is ${maxIntervals}.`
  return months.flatMap(Month => days.flatMap(day => hours.flatMap(Hour => minutes.map((Minute) => {
    const interval: CalendarInterval = {}
    if (Minute !== undefined) interval.Minute = Minute
    if (Hour !== undefined) interval.Hour = Hour
    Object.assign(interval, day)
    if (Month !== undefined) interval.Month = Month
    return interval
  }))))
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;")
}

function unxml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&")
}

function launchdLogFile(spec: OsTimerSpec, scope: OsScheduleScope, homedir: string): string {
  return join(spec.logDir ?? defaultLogDir(spec.name, scope, homedir), `${spec.name}.log`)
}

function defaultLogDir(name: string, scope: OsScheduleScope, homedir: string): string {
  return scope === "user" ? join(homedir, "Library/Logs", name) : join("/Library/Logs", name)
}

export function renderLaunchdPlist(spec: OsTimerSpec, intervals: readonly CalendarInterval[], logFile: string): string {
  const string = (value: string) => `<string>${xml(value)}</string>`
  const env = Object.entries(spec.env)
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    `<!-- ${generatedHeader} -->`,
    "<plist version=\"1.0\">",
    "<dict>",
    "\t<key>Label</key>",
    `\t${string(spec.name)}`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...spec.command.map(argument => `\t\t${string(argument)}`),
    "\t</array>",
    ...(env.length ? ["\t<key>EnvironmentVariables</key>", "\t<dict>", ...env.flatMap(([name, value]) => [`\t\t<key>${xml(name)}</key>`, `\t\t${string(value)}`]), "\t</dict>"] : []),
    ...(spec.cwd === undefined ? [] : ["\t<key>WorkingDirectory</key>", `\t${string(spec.cwd)}`]),
    "\t<key>StartCalendarInterval</key>",
    "\t<array>",
    ...intervals.flatMap((interval) => {
      const entries = Object.entries(interval)
      return entries.length ? ["\t\t<dict>", ...entries.flatMap(([key, value]) => [`\t\t\t<key>${key}</key>`, `\t\t\t<integer>${value}</integer>`]), "\t\t</dict>"] : ["\t\t<dict/>"]
    }),
    "\t</array>",
    "\t<key>StandardOutPath</key>",
    `\t${string(logFile)}`,
    "\t<key>StandardErrorPath</key>",
    `\t${string(logFile)}`,
    "\t<key>RunAtLoad</key>",
    "\t<false/>",
    "\t<key>ProcessType</key>",
    "\t<string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

/** Reads back the `StartCalendarInterval` dicts and the log path of a plist that `renderLaunchdPlist()` wrote. */
export function parseLaunchdPlist(plist: string): { intervals: CalendarInterval[], logFile?: string } {
  const array = plist.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ""
  const intervals = [...array.matchAll(/<dict\/>|<dict>([\s\S]*?)<\/dict>/g)].map((match) => {
    const interval: Record<string, number> = {}
    for (const [, key, value] of (match[1] ?? "").matchAll(/<key>(\w+)<\/key>\s*<integer>(\d+)<\/integer>/g)) {
      if (intervalKeys.has(key!)) interval[key!] = Number(value)
    }
    return interval as CalendarInterval
  })
  const logFile = plist.match(/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
  return { intervals, ...(logFile === undefined ? {} : { logFile: unxml(logFile) }) }
}

/** Reads `launchctl print` output: the `state` and `last exit code` lines of the service, one tab deep. */
function parseLaunchctlPrint(output: string): { running: boolean, lastExitCode?: number } {
  const state = output.match(/^\tstate = (.+)$/m)?.[1]?.trim()
  const lastExit = output.match(/^\tlast exit code = (-?\d+)/m)?.[1]
  return { running: state === "running", ...(lastExit === undefined ? {} : { lastExitCode: Number(lastExit) }) }
}

const dayMs = 24 * 60 * 60_000

/** UTC instant of a wall-clock time in `timeZone`. A time in a daylight saving gap moves forward by the gap. */
function zonedInstant(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): Date {
  const local = Date.UTC(year, month - 1, day, 0, minuteOfDay)
  const guess = local - timeZoneOffsetMinutes(new Date(local), timeZone) * 60_000
  return new Date(local - timeZoneOffsetMinutes(new Date(guess), timeZone) * 60_000)
}

function matchesInterval(interval: CalendarInterval, month: number, day: number, weekday: number): boolean {
  return (interval.Month === undefined || interval.Month === month) && (interval.Day === undefined || interval.Day === day) && (interval.Weekday === undefined || interval.Weekday % 7 === weekday)
}

/** The next time after `now` that one of `intervals` matches in `timeZone`, the machine zone that launchd uses. */
export function nextLaunchdRun(intervals: readonly CalendarInterval[], timeZone: string, now: Date): Date | undefined {
  const today = new Date(now.getTime() + timeZoneOffsetMinutes(now, timeZone) * 60_000)
  // Four years and a day reach every date, including 29 February.
  for (let offset = 0; offset <= 4 * 366; offset++) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + offset * dayMs)
    const [year, month, day, weekday] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()]
    const times = new Set<number>()
    for (const interval of intervals) {
      if (!matchesInterval(interval, month, day, weekday)) continue
      for (const hour of interval.Hour === undefined ? range(0, 23) : [interval.Hour]) {
        for (const minute of interval.Minute === undefined ? range(0, 59) : [interval.Minute]) times.add(hour * 60 + minute)
      }
    }
    for (const time of [...times].sort((left, right) => left - right)) {
      const instant = zonedInstant(year, month, day, time, timeZone)
      if (instant > now) return instant
    }
  }
  return undefined
}

const notFound = /could not find|no such process|not found/i
const marker = `<!-- ${generatedHeader} -->`

interface LoadedJob {
  domain: string
  output: string
}

/** launchd jobs: a LaunchAgent in the user's `gui` domain, or a LaunchDaemon in the `system` domain. */
export function createLaunchdDriver(host: OsHost, scope: OsScheduleScope): OsDriver {
  const plistPath = (name: string) => scope === "user" ? join(host.homedir, "Library/LaunchAgents", `${name}.plist`) : join("/Library/LaunchDaemons", `${name}.plist`)
  // Over SSH, a user has no `gui` domain. The `user` domain runs the agent there instead.
  const domains = scope === "user" ? [`gui/${host.uid}`, `user/${host.uid}`] : ["system"]

  function failed(args: readonly string[], result: ExecResult): Result<never, OsScheduleErrorCode> {
    return [osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED({ command: ["launchctl", ...args].join(" "), exitCode: result.code, output: commandOutput(result) }), undefined]
  }

  /** The domain that has the job loaded, and its `launchctl print` output. */
  async function loaded(name: string): Promise<LoadedJob | undefined> {
    for (const domain of domains) {
      const result = await host.exec("launchctl", ["print", `${domain}/${name}`])
      if (result.code === 0) return { domain, output: result.stdout }
    }
    return undefined
  }

  /**
   * The plist and the loaded job of `name`, and the resource that holds the name when ViteHub did not install it: a
   * plist at our path without our header, or a job with this label that launchd loaded from another plist.
   */
  async function owner(name: string): Promise<{ plist?: string, job?: LoadedJob, foreign?: string }> {
    const path = plistPath(name)
    const plist = await host.fs.readFile(path)
    const job = await loaded(name)
    const loadedFrom = job?.output.match(/^\tpath = (.+)$/m)?.[1]?.trim()
    let foreign: string | undefined
    if (plist !== undefined && !plist.includes(marker)) foreign = path
    else if (job && loadedFrom !== path) foreign = loadedFrom ?? `${job.domain}/${name}`
    return { ...(plist === undefined ? {} : { plist }), ...(job ? { job } : {}), ...(foreign ? { foreign } : {}) }
  }

  async function bootout(name: string, job: LoadedJob | undefined): Promise<Result<boolean, OsScheduleErrorCode>> {
    if (!job) return [undefined, false]
    const args = ["bootout", `${job.domain}/${name}`]
    const result = await host.exec("launchctl", args)
    return result.code === 0 || notFound.test(commandOutput(result)) ? [undefined, true] : failed(args, result)
  }

  async function bootstrapIn(domain: string, plist: string): Promise<ExecResult> {
    // launchd finishes a bootout in the background, so a bootstrap right after it can fail with error 5 for a moment.
    for (let attempt = 1; ; attempt++) {
      const result = await host.exec("launchctl", ["bootstrap", domain, plist])
      if (result.code === 0 || attempt === 10 || !/\b5: Input\/output error/.test(commandOutput(result))) return result
      await host.sleep(200)
    }
  }

  async function bootstrap(plist: string): Promise<Result<string, OsScheduleErrorCode>> {
    for (let index = 0; ; index++) {
      const domain = domains[index]!
      const result = await bootstrapIn(domain, plist)
      if (result.code === 0) return [undefined, domain]
      // 125: "Domain does not support specified action", as for `gui/<uid>` without a login session.
      const noSession = result.code === 125 || /domain does not support/i.test(commandOutput(result))
      if (!noSession || index === domains.length - 1) return failed(["bootstrap", domain, plist], result)
    }
  }

  return {
    async install(spec) {
      if (!spec.catchUp) return [osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED({ platform: "darwin", option: "catchUp", reason: "launchd always runs a time that the Mac missed while it slept, once it wakes. Remove `catchUp: false`." }), undefined]
      if (spec.randomDelaySeconds) return [osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED({ platform: "darwin", option: "randomDelaySeconds", reason: "launchd has no random delay. Remove the option, or set it to 0." }), undefined]
      const [zoneError, fields] = machineFieldsOrError("darwin", spec, host)
      if (zoneError) return [zoneError, undefined]
      const intervals = launchdIntervals(fields)
      if (typeof intervals === "string") return [osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED({ platform: "darwin", cron: spec.cron, reason: intervals }), undefined]
      const file = plistPath(spec.name)
      const logFile = launchdLogFile(spec, scope, host.homedir)
      const plist = renderLaunchdPlist(spec, intervals, logFile)
      const files = [file, logFile]
      const current = await owner(spec.name)
      if (current.foreign) return [osScheduleErrors.SCHEDULE_OS_NAME_TAKEN({ platform: "darwin", name: spec.name, scope, resource: current.foreign }), undefined]
      if (current.plist === plist && current.job) return [undefined, { files, changed: false }]
      const [bootoutError] = await bootout(spec.name, current.job)
      if (bootoutError) return [bootoutError, undefined]
      await host.fs.mkdir(spec.logDir ?? defaultLogDir(spec.name, scope, host.homedir))
      await host.fs.writeFile(file, plist)
      const [bootstrapError, domain] = await bootstrap(file)
      if (bootstrapError) return [bootstrapError, undefined]
      const enableArgs = ["enable", `${domain}/${spec.name}`]
      const enabled = await host.exec("launchctl", enableArgs)
      if (enabled.code !== 0) return failed(enableArgs, enabled)
      return [undefined, { files, changed: true }]
    },

    async status(name) {
      const { plist, job, foreign } = await owner(name)
      if (foreign) return [undefined, { name, platform: "darwin", scope, installed: false, running: false }]
      const parsed = plist === undefined ? undefined : parseLaunchdPlist(plist)
      const state = job ? parseLaunchctlPrint(job.output) : { running: false }
      const nextRunAt = job && parsed?.intervals.length ? nextLaunchdRun(parsed.intervals, host.machineTimeZone, host.now()) : undefined
      const status: OsScheduleStatus = {
        name,
        platform: "darwin",
        scope,
        installed: job !== undefined,
        ...state,
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(parsed?.logFile ? { logFile: parsed.logFile } : {}),
      }
      return [undefined, status]
    },

    async uninstall(name) {
      const file = plistPath(name)
      const { plist, job, foreign } = await owner(name)
      if (foreign) return [undefined, { name, platform: "darwin", scope, removed: [], existed: false }]
      const [bootoutError, wasLoaded] = await bootout(name, job)
      if (bootoutError) return [bootoutError, undefined]
      const logFile = plist === undefined ? undefined : parseLaunchdPlist(plist).logFile
      const removed: string[] = []
      for (const path of [file, ...(logFile ? [logFile] : [])]) {
        if (await host.fs.rm(path)) removed.push(path)
      }
      await host.fs.rmdirIfEmpty(defaultLogDir(name, scope, host.homedir))
      return [undefined, { name, platform: "darwin", scope, removed, existed: wasLoaded || plist !== undefined }]
    },
  }
}
