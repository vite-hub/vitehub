import { createHash } from "node:crypto"

import { arithmeticStep, isDayRestricted, isMonthRestricted, isWeekdayRestricted, range, runsEveryDay, timesOfDay } from "./cron.ts"
import { osScheduleErrors } from "./errors.ts"
import { commandOutput, generatedHeader, pathsFor } from "./host.ts"
import { clockChanges, machineFieldsOrError } from "./time-zone.ts"

import type { Result } from "@vite-hub/runtime"
import type { CronFields } from "./cron.ts"
import type { OsScheduleErrorCode, OsScheduleScope } from "./errors.ts"
import type { ExecResult, OsDriver, OsHost, OsScheduleStatus, OsTimerSpec } from "./host.ts"
import type { ClockChange } from "./time-zone.ts"

/** One time of day of a trigger, with an optional repetition inside the day. */
export interface TimeTrigger {
  /** Minute of the day. */
  start: number
  /** Without `duration`, the repetition does not end. */
  repetition?: { interval: string, duration?: string }
}

export type DaySchedule =
  /** One start that repeats without end, for a cron that runs all day, every day, at equal gaps. */
  | { kind: "always" }
  | { kind: "day" }
  | { kind: "week", weekdays: number[] }
  | { kind: "month", days: number[], months: number[] }

export interface TaskTriggers {
  times: TimeTrigger[]
  days: DaySchedule[]
}

const maxTriggers = 48
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
// Task Scheduler codes for a task that never ran and one that runs now. They are not exit codes.
const taskNeverRan = 267011
const taskRunning = 267009
const { join } = pathsFor("win32")

/** An XML duration, such as `PT23H52M30S`. */
function taskDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = seconds % 60
  return `PT${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}${rest || !seconds ? `${rest}S` : ""}`
}

/** `count` runs from `start`, `step` minutes apart, in minutes of the day. */
interface Runs {
  start: number
  step: number
  count: number
}

/** One trigger for the runs. The duration ends half a step after the last run. */
function trigger({ start, step, count }: Runs): TimeTrigger {
  if (count < 2) return { start }
  return { start, repetition: { interval: taskDuration(step * 60), duration: taskDuration((count - 1) * step * 60 + step * 30) } }
}

/**
 * Task Scheduler repeats a trigger in elapsed time. When the clocks change between the first and the last run, the
 * later runs move by the change, and the duration ends at another time of day. Such runs need one trigger per time.
 */
function crossesChange(runs: Runs, changes: readonly ClockChange[]): boolean {
  const last = runs.start + (runs.count - 1) * runs.step
  return runs.count > 1 && changes.some(change => runs.start < change.end && last >= change.start)
}

/** The fewest triggers that start at every time of the day of the cron, and keep their times across `changes`. */
function timeTriggers(fields: CronFields, changes: readonly ClockChange[]): TimeTrigger[] {
  const times = timesOfDay(fields)
  const single = (start: number): Runs => ({ start, step: 0, count: 1 })
  const candidates: Runs[][] = [times.map(single)]
  const step = arithmeticStep(times)
  if (step !== undefined) candidates.push([{ start: times[0]!, step, count: times.length }])
  const minuteStep = arithmeticStep(fields.minutes)
  if (minuteStep !== undefined) candidates.push(fields.hours.map(hour => ({ start: hour * 60 + fields.minutes[0]!, step: minuteStep, count: fields.minutes.length })))
  const hourStep = arithmeticStep(fields.hours)
  if (hourStep !== undefined) candidates.push(fields.minutes.map(minute => ({ start: fields.hours[0]! * 60 + minute, step: hourStep * 60, count: fields.hours.length })))
  const exact = candidates.map(candidate => candidate.flatMap(runs => crossesChange(runs, changes) ? range(0, runs.count - 1).map(index => single(runs.start + index * runs.step)) : [runs]))
  return exact.reduce((best, candidate) => candidate.length < best.length ? candidate : best).map(trigger)
}

function onDay(schedule: DaySchedule, change: ClockChange): boolean {
  switch (schedule.kind) {
    case "always":
    case "day": return true
    case "week": return schedule.weekdays.includes(change.weekday)
    case "month": return schedule.days.includes(change.day) && schedule.months.includes(change.month)
  }
}

function wallClock(minute: number): string {
  return `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`
}

/**
 * Triggers for the cron, or why Task Scheduler cannot run it exactly. `clock` has the clock changes of the machine
 * time zone, which Task Scheduler uses.
 */
export function taskTriggers(fields: CronFields, clock: { timeZone: string, changes: readonly ClockChange[] } = { timeZone: "UTC", changes: [] }): TaskTriggers | string {
  const dayRestricted = isDayRestricted(fields)
  const weekdayRestricted = isWeekdayRestricted(fields)
  const monthRestricted = isMonthRestricted(fields)
  if (weekdayRestricted && monthRestricted) return "a weekly trigger runs in every month, so it cannot keep a weekday list to some months."
  const days: DaySchedule[] = []
  if (weekdayRestricted) days.push({ kind: "week", weekdays: fields.weekdays })
  if (dayRestricted || monthRestricted) days.push({ kind: "month", days: fields.days, months: fields.months })
  if (!days.length) days.push({ kind: "day" })
  // Only a change on a day that the cron runs can move its runs.
  const changes = clock.changes.filter(change => days.some(schedule => onDay(schedule, change)))
  const times = timesOfDay(fields)
  const step = arithmeticStep(times)
  // A cron that runs all day at equal gaps keeps its times across a change of a multiple of the gap, when its
  // repetition does not end each day.
  if (changes.length && runsEveryDay(fields) && step && times.length * step === 24 * 60 && changes.every(change => change.delta % step === 0)) {
    return { times: [{ start: times[0]!, repetition: { interval: taskDuration(step * 60) } }], days: [{ kind: "always" }] }
  }
  const triggers = timeTriggers(fields, changes)
  const count = triggers.length * days.length
  if (count <= maxTriggers) return { times: triggers, days }
  const change = changes[0]
  if (change && timeTriggers(fields, []).length * days.length <= maxTriggers) {
    const [from, to] = change.delta > 0 ? [change.start, change.end] : [change.end, change.start]
    return `the clocks in ${clock.timeZone} change from ${wallClock(from)} to ${wallClock(to)} on ${change.year}-${pad(change.month)}-${pad(change.day)}, and Task Scheduler repeats a trigger in elapsed time, so the cron needs ${count} triggers to keep its times. The limit is ${maxTriggers}. Use fewer times of day, or times away from the clock change.`
  }
  return `it needs ${count} triggers, and the limit is ${maxTriggers}. Use times of day with equal gaps, such as "*/20 9-17 * * *".`
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;")
}

/** A PowerShell single-quoted string. PowerShell also reads the typographic single quotes as quotes. */
function powerShellString(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function renderDaySchedule(schedule: DaySchedule): string[] {
  switch (schedule.kind) {
    case "always": return []
    case "day": return ["      <ScheduleByDay>", "        <DaysInterval>1</DaysInterval>", "      </ScheduleByDay>"]
    case "week": return [
      "      <ScheduleByWeek>",
      "        <DaysOfWeek>",
      ...schedule.weekdays.map(weekday => `          <${weekdayNames[weekday]} />`),
      "        </DaysOfWeek>",
      "        <WeeksInterval>1</WeeksInterval>",
      "      </ScheduleByWeek>",
    ]
    case "month": return [
      "      <ScheduleByMonth>",
      "        <DaysOfMonth>",
      ...schedule.days.map(day => `          <Day>${day}</Day>`),
      "        </DaysOfMonth>",
      "        <Months>",
      ...schedule.months.map(month => `          <${monthNames[month - 1]} />`),
      "        </Months>",
      "      </ScheduleByMonth>",
    ]
  }
}

/** The `.ps1` file that the task runs: it sets the environment, runs the command, and appends its output to the log. */
export function renderTaskWrapper(spec: OsTimerSpec, logFile: string): string {
  return `\uFEFF${[
    `# ${generatedHeader}`,
    `$log = ${powerShellString(logFile)}`,
    ...Object.entries(spec.env).map(([name, value]) => `$env:${name} = ${powerShellString(value)}`),
    ...(spec.cwd === undefined ? [] : [`Set-Location -LiteralPath ${powerShellString(spec.cwd)}`]),
    // Stays 1 when the program cannot start.
    "$global:LASTEXITCODE = 1",
    `& ${spec.command.map(powerShellString).join(" ")} 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath $log -Append -Encoding utf8`,
    "exit $global:LASTEXITCODE",
    "",
  ].join("\n")}`
}

/** The log path that `renderTaskWrapper()` wrote. */
export function parseTaskWrapperLog(wrapper: string): string | undefined {
  return wrapper.match(/^\$log = '((?:[^']|'')*)'\r?$/m)?.[1]?.replaceAll("''", "'")
}

/** The task XML. The description ends with a hash of the XML and the wrapper, which a later install compares. */
export function renderTaskXml(spec: OsTimerSpec, triggers: TaskTriggers, options: { scope: OsScheduleScope, userId: string, wrapper: string, wrapperText: string }): string {
  const render = (description: string) => [
    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
    "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    "  <RegistrationInfo>",
    `    <Description>${xml(description)}</Description>`,
    `    <URI>\\${xml(spec.name)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    ...triggers.days.flatMap(days => triggers.times.flatMap(time => [
      // A time trigger starts once, and its repetition without a duration never ends.
      days.kind === "always" ? "    <TimeTrigger>" : "    <CalendarTrigger>",
      ...(time.repetition
        ? [
            "      <Repetition>",
            `        <Interval>${time.repetition.interval}</Interval>`,
            ...(time.repetition.duration ? [`        <Duration>${time.repetition.duration}</Duration>`] : []),
            "        <StopAtDurationEnd>false</StopAtDurationEnd>",
            "      </Repetition>",
          ]
        : []),
      // A fixed date in the past. Task Scheduler reads it in the machine's local time, with daylight saving time.
      `      <StartBoundary>2026-01-01T${pad(Math.floor(time.start / 60))}:${pad(time.start % 60)}:00</StartBoundary>`,
      "      <Enabled>true</Enabled>",
      ...(spec.randomDelaySeconds ? [`      <RandomDelay>${taskDuration(spec.randomDelaySeconds)}</RandomDelay>`] : []),
      ...renderDaySchedule(days),
      days.kind === "always" ? "    </TimeTrigger>" : "    </CalendarTrigger>",
    ])),
    "  </Triggers>",
    "  <Principals>",
    "    <Principal id=\"Author\">",
    ...(options.scope === "system"
      ? ["      <UserId>S-1-5-18</UserId>", "      <RunLevel>HighestAvailable</RunLevel>"]
      : [`      <UserId>${xml(options.userId)}</UserId>`, "      <LogonType>InteractiveToken</LogonType>", "      <RunLevel>LeastPrivilege</RunLevel>"]),
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    `    <StartWhenAvailable>${spec.catchUp}</StartWhenAvailable>`,
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>",
    "  </Settings>",
    "  <Actions Context=\"Author\">",
    "    <Exec>",
    "      <Command>powershell.exe</Command>",
    `      <Arguments>${xml(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${options.wrapper}"`)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n")
  // The marker names the scope: user and system tasks share the root folder, and each scope owns only its own tasks.
  const managed = `${spec.description}. Managed by ViteHub (${options.scope} scope).`
  const hash = createHash("sha256").update(render(managed)).update("\n").update(options.wrapperText).digest("hex")
  return render(`${managed} sha256:${hash}`)
}

/** The scope in the marker that `renderTaskXml()` put at the end of a task description, else `undefined`. */
export function taskOwnerScope(description: string | null | undefined): OsScheduleScope | undefined {
  const scope = description?.match(/Managed by ViteHub \((user|system) scope\)\. sha256:[0-9a-f]{64}$/)?.[1]
  return scope === "user" || scope === "system" ? scope : undefined
}

/** The hash that `renderTaskXml()` put in a task description. */
export function taskDescriptionHash(description: string | undefined): string | undefined {
  return description?.match(/sha256:([0-9a-f]{64})/)?.[1]
}

/**
 * Windows PowerShell 5.1 joins native arguments without escaping them, so a quote, an empty argument, or a trailing
 * backslash in an argument with spaces reaches the program changed.
 */
function unsafeWindowsArgument(argument: string): string | undefined {
  if (argument === "") return "an empty argument"
  if (argument.includes("\"")) return "an argument with a double quote"
  if (/\s/.test(argument) && argument.endsWith("\\")) return "an argument with spaces that ends with a backslash"
  return undefined
}

interface TaskInfo {
  installed: boolean
  state?: string
  description?: string | null
  lastRunTime?: string | null
  lastTaskResult?: number | null
  nextRunTime?: string | null
}

/** Reads the JSON of the status script. */
function parseTaskInfo(output: string): TaskInfo {
  const value: unknown = JSON.parse(output.trim() || "{}")
  if (typeof value !== "object" || value === null || !("installed" in value)) return { installed: false }
  return value as TaskInfo
}

function date(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function taskInfoScript(name: string): string {
  return [
    `$task = Get-ScheduledTask -TaskName ${powerShellString(name)} -TaskPath '\\' -ErrorAction SilentlyContinue`,
    "if (-not $task) { ConvertTo-Json -Compress @{ installed = $false }; exit 0 }",
    `$info = Get-ScheduledTaskInfo -TaskName ${powerShellString(name)} -TaskPath '\\'`,
    // Task Scheduler reports 30 November 1999 for a time that does not exist.
    "function Iso($date) { if ($date -and $date.Year -ge 2000) { $date.ToUniversalTime().ToString('o') } else { $null } }",
    "ConvertTo-Json -Compress @{ installed = $true; state = [string]$task.State; description = $task.Description; lastRunTime = (Iso $info.LastRunTime); lastTaskResult = $info.LastTaskResult; nextRunTime = (Iso $info.NextRunTime) }",
  ].join("\n")
}

/** Task Scheduler tasks in the root folder, run as the current user or as SYSTEM. */
export function createTaskSchedulerDriver(host: OsHost, scope: OsScheduleScope): OsDriver {
  /** A task of this name that ViteHub did not install in this scope. */
  const foreign = (task: TaskInfo) => task.installed && taskOwnerScope(task.description) !== scope
  const taskResource = (name: string, task: TaskInfo) => {
    const owner = taskOwnerScope(task.description)
    return owner ? `the ${owner}-scope task \\${name}` : `the task \\${name}`
  }

  const root = scope === "user"
    ? host.env.LOCALAPPDATA || join(host.homedir, "AppData", "Local")
    : host.env.ProgramData || host.env.PROGRAMDATA || "C:\\ProgramData"
  const wrapperPath = (name: string) => join(root, "ViteHub", "schedules", `${name}.ps1`)
  const defaultLogDir = (name: string) => join(root, name, "Logs")

  async function powershell(script: string): Promise<ExecResult> {
    const full = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`
    return host.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(full, "utf16le").toString("base64")])
  }

  async function run(command: string, script: string): Promise<Result<ExecResult, OsScheduleErrorCode>> {
    const result = await powershell(script)
    if (result.code === 0) return [undefined, result]
    const output = commandOutput(result)
    if (/access is denied|0x80070005/i.test(output)) return [osScheduleErrors.SCHEDULE_OS_PERMISSION_REQUIRED({ scope }), undefined]
    return [osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED({ command, exitCode: result.code, output }), undefined]
  }

  async function info(name: string): Promise<Result<TaskInfo, OsScheduleErrorCode>> {
    const [error, result] = await run(`Get-ScheduledTask -TaskName ${name}`, taskInfoScript(name))
    if (error) return [error, undefined]
    try {
      return [undefined, parseTaskInfo(result.stdout)]
    }
    catch {
      return [osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED({ command: `Get-ScheduledTask -TaskName ${name}`, exitCode: 0, output: `Unexpected output: ${commandOutput(result)}` }), undefined]
    }
  }

  return {
    async install(spec) {
      for (const argument of spec.command) {
        const problem = unsafeWindowsArgument(argument)
        if (problem) return [osScheduleErrors.SCHEDULE_OS_OPTION_UNSUPPORTED({ platform: "win32", option: "command", reason: `Windows PowerShell 5.1 passes ${problem} to the program changed. Remove it from ${JSON.stringify(argument)}.` }), undefined]
      }
      const [zoneError, fields] = machineFieldsOrError("win32", spec, host)
      if (zoneError) return [zoneError, undefined]
      const triggers = taskTriggers(fields, { timeZone: host.machineTimeZone, changes: clockChanges(host.machineTimeZone, host.now()) })
      if (typeof triggers === "string") return [osScheduleErrors.SCHEDULE_OS_CRON_UNSUPPORTED({ platform: "win32", cron: spec.cron, reason: triggers }), undefined]
      const wrapper = wrapperPath(spec.name)
      const logDir = spec.logDir ?? defaultLogDir(spec.name)
      const logFile = join(logDir, `${spec.name}.log`)
      const wrapperText = renderTaskWrapper(spec, logFile)
      const taskXml = renderTaskXml(spec, triggers, { scope, userId: host.user, wrapper, wrapperText })
      const files = [wrapper, logFile]
      const [infoError, current] = await info(spec.name)
      if (infoError) return [infoError, undefined]
      if (foreign(current)) return [osScheduleErrors.SCHEDULE_OS_NAME_TAKEN({ platform: "win32", name: spec.name, scope, resource: taskResource(spec.name, current) }), undefined]
      const unchanged = current.installed && current.state !== "Disabled" && taskDescriptionHash(current.description ?? undefined) === taskDescriptionHash(taskXml) && await host.fs.readFile(wrapper) === wrapperText
      if (unchanged) return [undefined, { files, changed: false }]
      await host.fs.mkdir(logDir)
      await host.fs.writeFile(wrapper, wrapperText)
      // The XML can pass the command line limit of -EncodedCommand, so the script reads it from a file.
      const xmlFile = join(root, "ViteHub", "schedules", `${spec.name}.xml`)
      await host.fs.writeFile(xmlFile, taskXml)
      const [registerError] = await run(`Register-ScheduledTask -TaskName ${spec.name}`, [
        `$xml = Get-Content -LiteralPath ${powerShellString(xmlFile)} -Raw -Encoding UTF8`,
        `Register-ScheduledTask -TaskName ${powerShellString(spec.name)} -TaskPath '\\' -Xml $xml -Force | Out-Null`,
      ].join("\n"))
      await host.fs.rm(xmlFile)
      if (registerError) {
        // Leave nothing behind when the first install fails.
        if (!current.installed) await host.fs.rm(wrapper)
        return [registerError, undefined]
      }
      return [undefined, { files, changed: true }]
    },

    async status(name) {
      const [error, task] = await info(name)
      if (error) return [error, undefined]
      if (foreign(task)) return [undefined, { name, platform: "win32", scope, installed: false, running: false }]
      const running = task.state === "Running"
      const lastRunAt = date(task.lastRunTime)
      const nextRunAt = date(task.nextRunTime)
      const result = task.lastTaskResult
      const exited = typeof result === "number" && result !== taskNeverRan && result !== taskRunning && !running
      const wrapper = await host.fs.readFile(wrapperPath(name))
      const logFile = wrapper === undefined ? undefined : parseTaskWrapperLog(wrapper)
      const status: OsScheduleStatus = {
        name,
        platform: "win32",
        scope,
        installed: task.installed,
        running,
        ...(lastRunAt ? { lastRunAt } : {}),
        ...(exited ? { lastExitCode: result } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(logFile ? { logFile } : {}),
      }
      return [undefined, status]
    },

    async uninstall(name) {
      const [infoError, task] = await info(name)
      if (infoError) return [infoError, undefined]
      if (foreign(task)) return [undefined, { name, platform: "win32", scope, removed: [], existed: false }]
      const wrapper = wrapperPath(name)
      const wrapperText = await host.fs.readFile(wrapper)
      if (task.installed) {
        const [error] = await run(`Unregister-ScheduledTask -TaskName ${name}`, `Unregister-ScheduledTask -TaskName ${powerShellString(name)} -TaskPath '\\' -Confirm:$false`)
        if (error) return [error, undefined]
      }
      const logFile = wrapperText === undefined ? undefined : parseTaskWrapperLog(wrapperText)
      const removed: string[] = []
      for (const path of [wrapper, ...(logFile ? [logFile] : [])]) {
        if (await host.fs.rm(path)) removed.push(path)
      }
      for (const directory of [defaultLogDir(name), join(root, name), join(root, "ViteHub", "schedules"), join(root, "ViteHub")]) await host.fs.rmdirIfEmpty(directory)
      return [undefined, { name, platform: "win32", scope, removed, existed: task.installed || wrapperText !== undefined }]
    },
  }
}

