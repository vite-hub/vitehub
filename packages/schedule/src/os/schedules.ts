import { isPlainObject } from "@vite-hub/internal/object"
import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"

import { parseCronFields } from "./cron.ts"
import { osScheduleErrors } from "./errors.ts"
import { createLaunchdDriver } from "./launchd.ts"
import { createSystemdDriver } from "./systemd.ts"
import { createTaskSchedulerDriver } from "./task-scheduler.ts"

import type { Result } from "@vite-hub/runtime"
import type { OsScheduleErrorCode, OsSchedulePlatform, OsScheduleScope } from "./errors.ts"
import type { OsDriver, OsHost, OsScheduleRemoval, OsScheduleStatus, OsTimerSpec } from "./host.ts"

/** Any object with `cron` and an optional `timeZone`. The result of `defineSchedule()` fits. */
export interface OsScheduleTiming {
  cron?: string
  /**
   * IANA time zone of the cron. Without it, the cron runs in UTC, as every Schedule does. `"local"` runs it in the time
   * zone of the machine.
   */
  timeZone?: string
}

export interface InstallOsScheduleOptions {
  /** Program and arguments. The program is an absolute path on the target OS, such as `process.execPath`. */
  command: readonly [string, ...string[]]
  /**
   * `"user"` (default): a systemd user timer, a LaunchAgent, or a task that runs as the current user while they are
   * logged in. `"system"`: a system timer, a LaunchDaemon, or a task that runs as SYSTEM. It needs root or Administrator.
   */
  scope?: OsScheduleScope
  /** Run a missed time once after the machine wakes or boots. Defaults to `true`. macOS always does, so `false` fails there. */
  catchUp?: boolean
  /** Environment variables of each run. Nothing is copied from the shell that installs the timer. */
  env?: Record<string, string>
  /** Absolute working directory of each run. Defaults to the home directory, or the OS default for `"system"`. */
  cwd?: string
  /**
   * Absolute directory of `<name>.log`, which collects the output of each run. Defaults to the journal on Linux,
   * `~/Library/Logs/<name>` on macOS, and `%LOCALAPPDATA%\<name>\Logs` on Windows (`/Library/Logs/<name>` and
   * `%ProgramData%\<name>\Logs` for `"system"`).
   */
  logDir?: string
  /** Start each run up to this many seconds late, at random. systemd and Task Scheduler only. */
  randomDelaySeconds?: number
  /** Defaults to `<name> (ViteHub schedule)`. */
  description?: string
}

export interface OsScheduleTarget {
  /** Defaults to `"user"`. */
  scope?: OsScheduleScope
}

export interface OsScheduleUnit {
  name: string
  platform: OsSchedulePlatform
  scope: OsScheduleScope
  /** Absolute paths of the files that the timer owns. `uninstallOsSchedule()` deletes them. */
  files: string[]
  /** `false` when everything was already up to date and the install changed nothing. */
  changed: boolean
  /** Linux user scope: whether systemd lingering is on. When it is off, the timer runs only while the user has a session. */
  linger?: boolean
  status(): Promise<Result<OsScheduleStatus, OsScheduleErrorCode>>
  uninstall(): Promise<Result<OsScheduleRemoval, OsScheduleErrorCode>>
}

const optionKeys = new Set(["catchUp", "command", "cwd", "description", "env", "logDir", "randomDelaySeconds", "scope"])
const namePattern = /^[A-Za-z0-9][\w.-]{0,99}$/
const variableName = /^[A-Z_a-z]\w*$/
const platforms = new Set<string>(["darwin", "linux", "win32"])

function invalid(problem: string): Result<never, OsScheduleErrorCode> {
  return [osScheduleErrors.SCHEDULE_OS_INVALID_OPTIONS({ problem }), undefined]
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPlatform(platform: string): platform is OsSchedulePlatform {
  return platforms.has(platform)
}

function isAbsolute(platform: OsSchedulePlatform, path: string): boolean {
  return platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) : path.startsWith("/")
}

function checkName(name: unknown): Result<string, OsScheduleErrorCode> {
  if (!isString(name) || !namePattern.test(name)) return invalid(`the name ${JSON.stringify(name)} must start with a letter or digit and use only letters, digits, ".", "_" and "-", up to 100 characters.`)
  return [undefined, name]
}

function checkScope(scope: unknown): Result<OsScheduleScope, OsScheduleErrorCode> {
  if (scope === undefined) return [undefined, "user"]
  if (scope === "user" || scope === "system") return [undefined, scope]
  return invalid("`scope` must be \"user\" or \"system\".")
}

function readSpec(platform: OsSchedulePlatform, name: string, schedule: unknown, options: unknown): Result<OsTimerSpec & { scope: OsScheduleScope }, OsScheduleErrorCode> {
  if (!isPlainObject(schedule) || schedule.cron === undefined) return invalid("pass a Schedule with `cron`, such as `defineSchedule({ cron: \"0 * * * *\", handler })`.")
  const { cron, timeZone = "UTC" } = schedule
  const fields = isString(cron) ? parseCronFields(cron) : undefined
  if (!isString(cron) || !fields) return invalid("`cron` must be a five-field cron expression, such as \"0 9 * * 1-5\".")
  if (timeZone !== "local" && !isIanaTimeZone(timeZone)) return invalid("`timeZone` must be an IANA time zone, such as \"Europe/Madrid\", or \"local\" for the time zone of the machine.")

  if (!isPlainObject(options)) return invalid("pass options with `command`.")
  const unknownKey = Object.keys(options).find(key => !optionKeys.has(key))
  if (unknownKey) return invalid(`\`${unknownKey}\` is not an option.`)
  const { catchUp = true, command, cwd, description = `${name} (ViteHub schedule)`, env = {}, logDir, randomDelaySeconds } = options
  if (!Array.isArray(command) || !command.length || !command.every(isString)) return invalid("`command` must be a list of strings: the program and its arguments.")
  if (!isAbsolute(platform, command[0])) return invalid(`\`command[0]\` must be an absolute path, such as process.execPath. ${JSON.stringify(command[0])} is not.`)
  const [scopeError, scope] = checkScope(options.scope)
  if (scopeError) return [scopeError, undefined]
  if (typeof catchUp !== "boolean") return invalid("`catchUp` must be a boolean.")
  if (!isPlainObject(env)) return invalid("`env` must be an object of strings.")
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!variableName.test(key)) return invalid(`\`env\` has an invalid variable name ${JSON.stringify(key)}.`)
    if (!isString(value)) return invalid(`\`env.${key}\` must be a string.`)
    variables[key] = value
  }
  for (const [option, path] of [["cwd", cwd], ["logDir", logDir]] as const) {
    if (path !== undefined && (!isString(path) || !isAbsolute(platform, path))) return invalid(`\`${option}\` must be an absolute path.`)
  }
  if (randomDelaySeconds !== undefined && !(Number.isInteger(randomDelaySeconds) && Number(randomDelaySeconds) >= 0)) return invalid("`randomDelaySeconds` must be a whole number of seconds, 0 or more.")
  if (!isString(description)) return invalid("`description` must be a string.")
  const spec = {
    name,
    description,
    cron,
    fields,
    timeZone,
    command,
    env: variables,
    catchUp,
    scope,
    ...(isString(cwd) ? { cwd } : {}),
    ...(isString(logDir) ? { logDir } : {}),
    ...(typeof randomDelaySeconds === "number" ? { randomDelaySeconds } : {}),
  }
  // A line break ends a systemd setting, and would let a value add settings of its own.
  if (platform === "linux") {
    const values = [...command, ...Object.values(variables), cwd, logDir, description].filter(isString)
    if (values.some(value => /[\n\r]/.test(value))) return invalid("systemd values must be one line. Remove the line break from `command`, `env`, `cwd`, `logDir` or `description`.")
  }
  return [undefined, spec]
}

export interface OsSchedules {
  installOsSchedule(name: string, schedule: OsScheduleTiming, options: InstallOsScheduleOptions): Promise<Result<OsScheduleUnit, OsScheduleErrorCode>>
  osScheduleStatus(name: string, target?: OsScheduleTarget): Promise<Result<OsScheduleStatus, OsScheduleErrorCode>>
  uninstallOsSchedule(name: string, target?: OsScheduleTarget): Promise<Result<OsScheduleRemoval, OsScheduleErrorCode>>
}

/** The public functions on `host`. Tests pass a fake host. */
export function createOsSchedules(host: OsHost): OsSchedules {
  function driver(scope: OsScheduleScope): Result<{ platform: OsSchedulePlatform, driver: OsDriver }, OsScheduleErrorCode> {
    const platform = host.platform
    if (!isPlatform(platform)) return [osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED({ platform }), undefined]
    const create = platform === "linux" ? createSystemdDriver : platform === "darwin" ? createLaunchdDriver : createTaskSchedulerDriver
    return [undefined, { platform, driver: create(host, scope) }]
  }

  function target(name: unknown, options: unknown): Result<{ name: string, platform: OsSchedulePlatform, scope: OsScheduleScope, driver: OsDriver }, OsScheduleErrorCode> {
    const [nameError, checked] = checkName(name)
    if (nameError) return [nameError, undefined]
    if (options !== undefined && !isPlainObject(options)) return invalid("pass `{ scope }` or nothing.")
    const unknownKey = Object.keys(options ?? {}).find(key => key !== "scope")
    if (unknownKey) return invalid(`\`${unknownKey}\` is not an option.`)
    const [scopeError, scope] = checkScope(options?.scope)
    if (scopeError) return [scopeError, undefined]
    const [driverError, found] = driver(scope)
    if (driverError) return [driverError, undefined]
    return [undefined, { name: checked, scope, ...found }]
  }

  async function osScheduleStatus(name: string, options?: OsScheduleTarget): Promise<Result<OsScheduleStatus, OsScheduleErrorCode>> {
    const [error, found] = target(name, options)
    if (error) return [error, undefined]
    return found.driver.status(found.name)
  }

  async function uninstallOsSchedule(name: string, options?: OsScheduleTarget): Promise<Result<OsScheduleRemoval, OsScheduleErrorCode>> {
    const [error, found] = target(name, options)
    if (error) return [error, undefined]
    return found.driver.uninstall(found.name)
  }

  async function installOsSchedule(name: string, schedule: OsScheduleTiming, options: InstallOsScheduleOptions): Promise<Result<OsScheduleUnit, OsScheduleErrorCode>> {
    const [nameError, checked] = checkName(name)
    if (nameError) return [nameError, undefined]
    if (!isPlatform(host.platform)) return [osScheduleErrors.SCHEDULE_OS_PLATFORM_UNSUPPORTED({ platform: host.platform }), undefined]
    const [specError, spec] = readSpec(host.platform, checked, schedule, options)
    if (specError) return [specError, undefined]
    const { scope } = spec
    if (scope === "system" && host.uid !== undefined && host.uid !== 0) return [osScheduleErrors.SCHEDULE_OS_PERMISSION_REQUIRED({ scope }), undefined]
    const [driverError, found] = driver(scope)
    if (driverError) return [driverError, undefined]
    // A user timer runs in the home directory unless `cwd` says otherwise, as a systemd user service does.
    const withCwd = spec.cwd === undefined && scope === "user" ? { ...spec, cwd: host.homedir } : spec
    const [installError, installation] = await found.driver.install(withCwd)
    if (installError) return [installError, undefined]
    return [undefined, {
      name: checked,
      platform: found.platform,
      scope,
      ...installation,
      status: () => osScheduleStatus(checked, { scope }),
      uninstall: () => uninstallOsSchedule(checked, { scope }),
    }]
  }

  return { installOsSchedule, osScheduleStatus, uninstallOsSchedule }
}
