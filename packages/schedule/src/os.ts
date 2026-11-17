import { createNodeHost } from "./os/host.ts"
import { createOsSchedules } from "./os/schedules.ts"

import type { Result } from "@vite-hub/runtime"
import type { OsScheduleErrorCode } from "./os/errors.ts"
import type { OsScheduleRemoval, OsScheduleStatus } from "./os/host.ts"
import type { InstallOsScheduleOptions, OsSchedules, OsScheduleTarget, OsScheduleTiming, OsScheduleUnit } from "./os/schedules.ts"

export { osScheduleErrors } from "./os/errors.ts"
export type { OsScheduleErrorCode, OsSchedulePlatform, OsScheduleScope } from "./os/errors.ts"
export type { OsScheduleRemoval, OsScheduleStatus } from "./os/host.ts"
export type { InstallOsScheduleOptions, OsScheduleTarget, OsScheduleTiming, OsScheduleUnit } from "./os/schedules.ts"

let schedules: OsSchedules | undefined

function nodeSchedules(): OsSchedules {
  schedules ??= createOsSchedules(createNodeHost())
  return schedules
}

/**
 * Installs `schedule` as an OS timer named `name` that runs `options.command`: a systemd timer on Linux, a launchd job
 * on macOS, or a Task Scheduler task on Windows. It runs on the Schedule's `cron` in its `timeZone`, or fails with a
 * code when the OS cannot run that cron exactly. Installing the same timer again changes nothing. It fails with
 * `SCHEDULE_OS_NAME_TAKEN` when the OS already has a timer of that name that ViteHub did not install in this scope.
 */
export function installOsSchedule(name: string, schedule: OsScheduleTiming, options: InstallOsScheduleOptions): Promise<Result<OsScheduleUnit, OsScheduleErrorCode>> {
  return nodeSchedules().installOsSchedule(name, schedule, options)
}

/** Reads the state of the OS timer `name`: whether it is installed and running, its last run and exit code, and its next run. */
export function osScheduleStatus(name: string, target?: OsScheduleTarget): Promise<Result<OsScheduleStatus, OsScheduleErrorCode>> {
  return nodeSchedules().osScheduleStatus(name, target)
}

/**
 * Stops and removes the OS timer `name` and the files that it owns. Removing a timer that does not exist succeeds.
 * A timer of the same name that ViteHub did not install in this scope stays as it is, and `existed` is `false`.
 */
export function uninstallOsSchedule(name: string, target?: OsScheduleTarget): Promise<Result<OsScheduleRemoval, OsScheduleErrorCode>> {
  return nodeSchedules().uninstallOsSchedule(name, target)
}
