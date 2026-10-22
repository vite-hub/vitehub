// Constants of the Workspace-backed Content runtime, kept here so the main `@vite-hub/content` entry can export them
// without loading Workspace.

/** The history ref that stores pending and failed schedules, one file per schedule. */
export const contentSchedulesRef = "schedules" as const

/** A pending schedule this long past its time has not run: no runner fired, or it fires less often. */
export const contentScheduleOverdueMs: number = 5 * 60_000

/** How long sessions count, in milliseconds. */
export interface ContentSessionTimeouts {
  presence: number
  lease: number
  idle: number
}

/**
 * How long sessions count, in milliseconds. A report keeps a session present for `presence`. Taking or renewing the
 * edit lease keeps it for `lease`. A lease without reported input for `idle` stops blocking others.
 */
export const contentSessionTimeouts: Readonly<ContentSessionTimeouts> = Object.freeze({ presence: 45_000, lease: 300_000, idle: 900_000 })
