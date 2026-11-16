import { defineErrors } from "@vite-hub/runtime"

import type { ErrorCatalog } from "@vite-hub/runtime"

/** Operating systems that `@vite-hub/schedule/os` installs timers on, as `process.platform` names them. */
export type OsSchedulePlatform = "linux" | "darwin" | "win32"
/** `"user"` runs as the current user. `"system"` runs as root or SYSTEM and needs root or Administrator to install. */
export type OsScheduleScope = "user" | "system"

type CommandFailed = { command: string, exitCode: number, output: string }
type CronUnsupported = { platform: OsSchedulePlatform, cron: string, reason: string }
type InvalidOptions = { problem: string }
type OptionUnsupported = { platform: OsSchedulePlatform, option: string, reason: string }
type PermissionRequired = { scope: OsScheduleScope }
type PlatformUnsupported = { platform: string }
type TimeZoneUnsupported = { platform: OsSchedulePlatform, timeZone: string, machineTimeZone: string }

/** A code whose `error.data` holds the values of its message. */
type Code<TData> = { fix: string, why: (data: TData) => string, data: (data: TData) => TData }

// A type alias, not an interface, so it fits the index signature of `defineErrors()`.
type OsScheduleErrorCodes = {
  SCHEDULE_OS_COMMAND_FAILED: Code<CommandFailed>
  SCHEDULE_OS_CRON_UNSUPPORTED: Code<CronUnsupported>
  SCHEDULE_OS_INVALID_OPTIONS: Code<InvalidOptions>
  SCHEDULE_OS_OPTION_UNSUPPORTED: Code<OptionUnsupported>
  SCHEDULE_OS_PERMISSION_REQUIRED: Code<PermissionRequired>
  SCHEDULE_OS_PLATFORM_UNSUPPORTED: Code<PlatformUnsupported>
  SCHEDULE_OS_TIME_ZONE_UNSUPPORTED: Code<TimeZoneUnsupported>
}

const platformNames: Record<OsSchedulePlatform, string> = { darwin: "launchd", linux: "systemd", win32: "Task Scheduler" }

// Errors that `installOsSchedule()`, `osScheduleStatus()`, and `uninstallOsSchedule()` return as `[error, undefined]`.
// Keep published codes stable.
export const osScheduleErrors: ErrorCatalog<OsScheduleErrorCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/schedule/diagnostics",
  codes: {
    SCHEDULE_OS_COMMAND_FAILED: {
      why: ({ command, exitCode, output }: CommandFailed) => `\`${command}\` failed with exit code ${exitCode}: ${output || "no output"}`,
      fix: "Read the output. On Linux, \"Failed to connect to bus\" means that the user has no systemd user manager: run `loginctl enable-linger <user>`, or run inside a login session with `XDG_RUNTIME_DIR` set. On macOS over SSH, the `gui` domain is missing: log in at the screen once, or install with `scope: \"system\"`.",
      data: (data: CommandFailed) => data,
    },
    SCHEDULE_OS_CRON_UNSUPPORTED: {
      why: ({ platform, cron, reason }: CronUnsupported) => `${platformNames[platform]} cannot run the cron "${cron}" exactly: ${reason}`,
      fix: "Rewrite the cron with fewer values, such as one weekday list without a month list, or a step that divides the hour or day evenly. systemd on Linux runs every five-field cron.",
      data: (data: CronUnsupported) => data,
    },
    SCHEDULE_OS_INVALID_OPTIONS: {
      why: ({ problem }: InvalidOptions) => `The OS timer options are invalid: ${problem}`,
      fix: "Pass a name of letters, digits, \".\", \"_\" and \"-\", a Schedule with a five-field `cron`, and `{ command }` with an absolute program path.",
      data: (data: InvalidOptions) => data,
    },
    SCHEDULE_OS_OPTION_UNSUPPORTED: {
      why: ({ platform, option, reason }: OptionUnsupported) => `${platformNames[platform]} does not support \`${option}\`: ${reason}`,
      fix: "Remove the option on this operating system, or give it a value that the error names.",
      data: (data: OptionUnsupported) => data,
    },
    SCHEDULE_OS_PERMISSION_REQUIRED: {
      why: ({ scope }: PermissionRequired) => `Installing an OS timer with \`scope: "${scope}"\` needs root or Administrator.`,
      fix: "Run as root (`sudo`) or from an Administrator shell, or install with `scope: \"user\"`.",
      data: (data: PermissionRequired) => data,
    },
    SCHEDULE_OS_PLATFORM_UNSUPPORTED: {
      why: ({ platform }: PlatformUnsupported) => `OS timers are not supported on "${platform}".`,
      fix: "Install OS timers on Linux with systemd, macOS, or Windows. On other hosts, run the Schedule with a ViteHub Schedule runtime.",
      data: (data: PlatformUnsupported) => data,
    },
    SCHEDULE_OS_TIME_ZONE_UNSUPPORTED: {
      why: ({ platform, timeZone, machineTimeZone }: TimeZoneUnsupported) => `${platformNames[platform]} runs timers in the machine time zone "${machineTimeZone}", and the cron gives other runs there than in "${timeZone}".`,
      fix: "Set the Schedule `timeZone` to the machine time zone, or use a cron that gives the same runs in both zones, such as an hourly cron when the zones differ by whole hours. systemd on Linux runs a cron in any time zone.",
      data: (data: TimeZoneUnsupported) => data,
    },
  },
})

export type OsScheduleErrorCode = keyof OsScheduleErrorCodes
