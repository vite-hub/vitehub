import { invariantError } from "@vite-hub/internal/invariant"
import { systemdAssignment, systemdExecArgument, systemdValue } from "@vite-hub/internal/systemd"

import { isDayRestricted, isWeekdayRestricted } from "./cron.ts"
import { osScheduleErrors } from "./errors.ts"
import { commandOutput, generatedHeader, pathsFor } from "./host.ts"

import type { Result } from "@vite-hub/runtime"
import type { CronFields } from "./cron.ts"
import type { OsScheduleErrorCode, OsScheduleScope } from "./errors.ts"
import type { ExecResult, OsDriver, OsHost, OsScheduleStatus, OsTimerSpec } from "./host.ts"

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const { join } = pathsFor("linux")

function lineBreak(): never {
  throw invariantError("a systemd value has a line break after validation")
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function calendarList(values: readonly number[], size: number, format: (value: number) => string = pad): string {
  if (values.length === size) return "*"
  const parts: string[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === values[end]! + 1) end++
    if (end - start >= 2) parts.push(`${format(values[start]!)}..${format(values[end]!)}`)
    else for (let index = start; index <= end; index++) parts.push(format(values[index]!))
    start = end + 1
  }
  return parts.join(",")
}

/**
 * `OnCalendar=` values of the cron in `timeZone`. systemd ANDs a weekday with the date, and cron ORs a restricted day
 * of the month with a restricted weekday, so that case takes two lines.
 */
export function systemdCalendars(fields: CronFields, timeZone: string): string[] {
  const time = `${calendarList(fields.hours, 24)}:${calendarList(fields.minutes, 60)}:00${timeZone === "local" ? "" : ` ${timeZone}`}`
  const months = calendarList(fields.months, 12)
  const weekdays = calendarList(fields.weekdays.map(weekday => weekday || 7).sort((left, right) => left - right), 7, weekday => weekdayNames[weekday % 7]!)
  const byWeekday = `${weekdays} *-${months}-* ${time}`
  const byDay = `*-${months}-${calendarList(fields.days, 31)} ${time}`
  if (isWeekdayRestricted(fields)) return isDayRestricted(fields) ? [byWeekday, byDay] : [byWeekday]
  return [byDay]
}

function systemdLogFile(spec: OsTimerSpec): string | undefined {
  return spec.logDir === undefined ? undefined : join(spec.logDir, `${spec.name}.log`)
}

export function renderSystemdService(spec: OsTimerSpec): string {
  const logFile = systemdLogFile(spec)
  return [
    `# ${generatedHeader}`,
    "[Unit]",
    `Description=${systemdValue(spec.description, lineBreak)}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${spec.command.map(argument => systemdExecArgument(argument, lineBreak)).join(" ")}`,
    ...(spec.cwd === undefined ? [] : [`WorkingDirectory=${systemdValue(spec.cwd, lineBreak)}`]),
    ...Object.entries(spec.env).map(([name, value]) => `Environment=${systemdAssignment(name, value, lineBreak)}`),
    ...(logFile === undefined ? [] : [`StandardOutput=append:${systemdValue(logFile, lineBreak)}`, `StandardError=append:${systemdValue(logFile, lineBreak)}`]),
    `SyslogIdentifier=${spec.name}`,
    "",
  ].join("\n")
}

export function renderSystemdTimer(spec: OsTimerSpec): string {
  return [
    `# ${generatedHeader}`,
    "[Unit]",
    `Description=${systemdValue(spec.description, lineBreak)}`,
    "",
    "[Timer]",
    ...systemdCalendars(spec.fields, spec.timeZone).map(calendar => `OnCalendar=${calendar}`),
    `Persistent=${spec.catchUp}`,
    "AccuracySec=1s",
    ...(spec.randomDelaySeconds ? [`RandomizedDelaySec=${spec.randomDelaySeconds}`] : []),
    `Unit=${spec.name}.service`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n")
}

function parseSystemctlShow(output: string): Map<string, Map<string, string>> {
  const units = new Map<string, Map<string, string>>()
  for (const block of output.split(/\n\s*\n/)) {
    const properties = new Map<string, string>()
    for (const line of block.split("\n")) {
      const index = line.indexOf("=")
      if (index > 0) properties.set(line.slice(0, index), line.slice(index + 1))
    }
    const id = properties.get("Id")
    if (id) units.set(id, properties)
  }
  return units
}

function unixTimestamp(value: string | undefined): Date | undefined {
  const seconds = Number(value?.replace(/^@/, ""))
  return value && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
}

const statusProperties = ["Id", "LoadState", "FragmentPath", "ActiveState", "SubState", "NextElapseUSecRealtime", "LastTriggerUSec", "ExecMainStartTimestamp", "ExecMainExitTimestamp", "ExecMainCode", "ExecMainStatus", "Result"]
const exitedCode = "1"

const marker = `# ${generatedHeader}`

interface UnitPaths {
  service: string
  timer: string
}

async function foreignResource(host: OsHost, paths: UnitPaths, texts: { service?: string, timer?: string }, units: Map<string, Map<string, string>>, name: string): Promise<string | undefined> {
  for (const kind of ["service", "timer"] as const) {
    const text = texts[kind]
    if (text !== undefined && !text.startsWith(marker)) return paths[kind]
    const unit = units.get(`${name}.${kind}`)
    const state = unit?.get("LoadState")
    if (!state || state === "not-found") continue
    const fragment = unit?.get("FragmentPath")
    if (!fragment) return `${name}.${kind}`
    if (fragment !== paths[kind] && await host.fs.realpath(fragment) !== await host.fs.realpath(paths[kind])) return fragment
  }
  return undefined
}

/**
 * The folder of user units that the systemd user manager reads: `<config home>/systemd/user`, next to the
 * `user.control` folder that comes first in its unit path. The manager has its own environment, so the
 * XDG_CONFIG_HOME or HOME of this process can point elsewhere.
 */
export function userUnitDirectory(unitPath: string): string | undefined {
  const paths = unitPath.trim().split(/\s+/)
  const control = paths.find(path => path.endsWith("/systemd/user.control"))
  const directory = control?.slice(0, -".control".length)
  return directory?.startsWith("/") && paths.includes(directory) ? directory : undefined
}

/** systemd timers, as `systemctl --user` units or system units in /etc/systemd/system. */
export function createSystemdDriver(host: OsHost, scope: OsScheduleScope): OsDriver {
  const user = scope === "user"
  const execEnv = user && !host.env.XDG_RUNTIME_DIR && host.uid !== undefined ? { XDG_RUNTIME_DIR: `/run/user/${host.uid}` } : undefined
  let directory: Promise<string> | undefined

  async function unitDirectory(): Promise<string> {
    if (!user) return "/etc/systemd/system"
    const result = await systemctl("show", "-p", "UnitPath", "--value")
    return (result.code === 0 ? userUnitDirectory(result.stdout) : undefined) ?? join(host.env.XDG_CONFIG_HOME || join(host.homedir, ".config"), "systemd/user")
  }

  async function paths(name: string): Promise<UnitPaths> {
    directory ??= unitDirectory()
    const folder = await directory
    return { service: join(folder, `${name}.service`), timer: join(folder, `${name}.timer`) }
  }

  function systemctl(...args: string[]): Promise<ExecResult> {
    return host.exec("systemctl", user ? ["--user", ...args] : args, execEnv)
  }

  function failed(args: readonly string[], result: ExecResult): Result<never, OsScheduleErrorCode> {
    const command = ["systemctl", ...(user ? ["--user"] : []), ...args].join(" ")
    return [osScheduleErrors.SCHEDULE_OS_COMMAND_FAILED({ command, exitCode: result.code, output: commandOutput(result) }), undefined]
  }

  async function run(...args: string[]): Promise<Result<ExecResult, OsScheduleErrorCode>> {
    const result = await systemctl(...args)
    return result.code === 0 ? [undefined, result] : failed(args, result)
  }

  async function linger(): Promise<boolean | undefined> {
    if (!user) return undefined
    const result = await host.exec("loginctl", ["show-user", host.user, "-p", "Linger", "--value"])
    return result.code === 0 && result.stdout.trim() === "yes"
  }

  function logFileOf(service: string | undefined): string | undefined {
    const value = service?.match(/^StandardOutput=append:(.*)$/m)?.[1]
    return value?.replaceAll("%%", "%")
  }

  async function readUnits(files: UnitPaths): Promise<{ service?: string, timer?: string }> {
    const [service, timer] = [await host.fs.readFile(files.service), await host.fs.readFile(files.timer)]
    return { ...(service === undefined ? {} : { service }), ...(timer === undefined ? {} : { timer }) }
  }

  async function foreign(name: string, files: UnitPaths, texts: { service?: string, timer?: string }): Promise<Result<string | undefined, OsScheduleErrorCode>> {
    const fileOwner = await foreignResource(host, files, texts, new Map(), name)
    if (fileOwner) return [undefined, fileOwner]
    const [error, result] = await run("show", `${name}.service`, `${name}.timer`, "-p", "Id,LoadState,FragmentPath")
    if (error) return [error, undefined]
    return [undefined, await foreignResource(host, files, texts, parseSystemctlShow(result.stdout), name)]
  }

  return {
    async install(spec) {
      const files = await paths(spec.name)
      const service = renderSystemdService(spec)
      const timer = renderSystemdTimer(spec)
      const current = await readUnits(files)
      const [foreignError, resource] = await foreign(spec.name, files, current)
      if (foreignError) return [foreignError, undefined]
      if (resource) return [osScheduleErrors.SCHEDULE_OS_NAME_TAKEN({ platform: "linux", name: spec.name, scope, resource }), undefined]
      const changed = current.service !== service || current.timer !== timer
      const logFile = systemdLogFile(spec)
      if (spec.logDir !== undefined) await host.fs.mkdir(spec.logDir)
      const unit = `${spec.name}.timer`
      if (changed) {
        await host.fs.writeFile(files.service, service)
        await host.fs.writeFile(files.timer, timer)
        const [reloadError] = await run("daemon-reload")
        if (reloadError) return [reloadError, undefined]
        const [enableError] = await run("enable", unit)
        if (enableError) return [enableError, undefined]
        const [restartError] = await run("restart", unit)
        if (restartError) return [restartError, undefined]
      }
      const enabled = (await systemctl("is-enabled", unit)).stdout.trim() === "enabled"
      const active = (await systemctl("is-active", unit)).stdout.trim() === "active"
      let started = false
      if (!enabled || !active) {
        const [startError] = await run("enable", "--now", unit)
        if (startError) return [startError, undefined]
        started = true
      }
      return [undefined, {
        files: [files.service, files.timer, ...(logFile === undefined ? [] : [logFile])],
        changed: changed || started,
        ...(user ? { linger: await linger() } : {}),
      }]
    },

    async status(name) {
      const args = ["show", `${name}.timer`, `${name}.service`, "--timestamp=unix", "-p", statusProperties.join(",")]
      const [error, result] = await run(...args)
      if (error) return [error, undefined]
      const units = parseSystemctlShow(result.stdout)
      const files = await paths(name)
      const texts = await readUnits(files)
      const lingering = await linger()
      if (await foreignResource(host, files, texts, units, name)) {
        return [undefined, { name, platform: "linux", scope, installed: false, running: false, ...(lingering === undefined ? {} : { linger: lingering }) }]
      }
      const timer = units.get(`${name}.timer`)
      const service = units.get(`${name}.service`)
      const installed = timer?.get("LoadState") === "loaded"
      const running = ["activating", "active", "deactivating", "reloading"].includes(service?.get("ActiveState") ?? "")
      const exited = unixTimestamp(service?.get("ExecMainExitTimestamp")) !== undefined
      const exitStatus = Number(service?.get("ExecMainStatus"))
      const lastRunAt = unixTimestamp(service?.get("ExecMainStartTimestamp"))
      const nextRunAt = unixTimestamp(timer?.get("NextElapseUSecRealtime"))
      const logFile = logFileOf(texts.service)
      const status: OsScheduleStatus = {
        name,
        platform: "linux",
        scope,
        installed,
        running,
        ...(lastRunAt ? { lastRunAt } : {}),
        ...(exited && !running && Number.isInteger(exitStatus) ? { lastExitCode: service?.get("ExecMainCode") === exitedCode ? exitStatus : 128 + exitStatus } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        ...(lingering === undefined ? {} : { linger: lingering }),
        ...(logFile ? { logFile } : {}),
      }
      return [undefined, status]
    },

    async uninstall(name) {
      const files = await paths(name)
      const texts = await readUnits(files)
      const logFile = logFileOf(texts.service)
      const nothing = { name, platform: "linux" as const, scope, removed: [], existed: false }
      if (texts.service === undefined && texts.timer === undefined) return [undefined, nothing]
      const [foreignError, resource] = await foreign(name, files, texts)
      if (foreignError) return [foreignError, undefined]
      if (resource) return [undefined, nothing]
      const notLoaded = /not loaded|does not exist|not found/i
      for (const args of [["disable", "--now", `${name}.timer`], ["stop", `${name}.service`]]) {
        const result = await systemctl(...args)
        if (result.code !== 0 && !notLoaded.test(commandOutput(result))) return failed(args, result)
      }
      await systemctl("clean", "--what=state", `${name}.timer`)
      const removed: string[] = []
      for (const file of [files.timer, files.service, ...(logFile ? [logFile] : [])]) {
        if (await host.fs.rm(file)) removed.push(file)
      }
      const [reloadError] = await run("daemon-reload")
      if (reloadError) return [reloadError, undefined]
      await systemctl("reset-failed", `${name}.service`, `${name}.timer`)
      return [undefined, { name, platform: "linux", scope, removed, existed: true }]
    },
  }
}
