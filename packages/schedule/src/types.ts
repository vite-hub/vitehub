export interface ScheduleRunContext {
  id: string
  attemptId?: string
  /** The `payload` that `startSchedule()` stored. Absent for a run on the Definition's own cron. */
  payload?: unknown
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  /** Name of the Schedule Definition that runs. */
  target?: string
  waitUntil(promise: PromiseLike<unknown>): void
}

export type ScheduleHandler<TResult = unknown> = {
  bivarianceHack(context: ScheduleRunContext): TResult | Promise<TResult>
}["bivarianceHack"]

export interface ScheduleDefinitionInput<TResult = unknown> {
  /** Allows `runSchedule()`, the Console, and `vitehub schedule run` to start a Definition with `cron` outside its cron. */
  manual?: boolean
  /**
   * Five-field cron expression, evaluated in `timeZone`. Leave it out for a Schedule that runs only when code starts it
   * with `startSchedule()`.
   */
  cron?: string
  handler: ScheduleHandler<TResult>
  /**
   * IANA time zone of `cron`, such as `"Europe/Madrid"`. Defaults to `"UTC"`. The process driver follows daylight
   * saving time. Provider cron output (Cloudflare, Vercel, Netlify, Deno) supports only UTC.
   */
  timeZone?: string
}

export interface ScheduleDefinitionOptions {
  /** Allows `runSchedule()`, the Console, and `vitehub schedule run` to start a Definition with `cron` outside its cron. */
  manual?: boolean
  /** IANA time zone of the cron, such as `"Europe/Madrid"`. Defaults to `"UTC"`. */
  timeZone?: string
}

export interface ScheduleDefinition<TResult = unknown> {
  /** Absent for a Schedule that runs only when code starts it with `startSchedule()`. */
  cron?: string
  handler: ScheduleHandler<TResult>
  /** IANA time zone of `cron`. Absent means UTC. */
  timeZone?: string
  options?: Omit<ScheduleDefinitionOptions, "timeZone">
}

export type ScheduleRegistryDefinition = ScheduleDefinition

export interface ScheduleDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ScheduleRegistryDefinition } | ScheduleRegistryDefinition>
}

export type ScheduleRunStatus = "pending" | "running" | "succeeded" | "failed"

export type ScheduleRunAttemptStatus = "running" | "succeeded" | "failed"

export interface ScheduleRunError {
  message: string
  name?: string
  stack?: string
}

/** Serializable representation of a schedule invocation response. */
export type ScheduleRunResponse = SerializedResponse

export interface ScheduleRunRecord {
  attemptCount: number
  completedAt?: Date
  createdAt: Date
  error?: ScheduleRunError
  id: string
  scheduleId: string
  response?: ScheduleRunResponse
  scheduledAt: Date
  startedAt?: Date
  status: ScheduleRunStatus
  /** Name of the Schedule Definition that ran. */
  target: string
  updatedAt: Date
}

export interface ScheduleRunAttemptRecord {
  completedAt?: Date
  createdAt: Date
  error?: ScheduleRunError
  id: string
  runId: string
  startedAt: Date
  status: ScheduleRunAttemptStatus
  updatedAt: Date
}

export interface ScheduleRunListOptions {
  /** Only records whose ID starts with this prefix. Applied before `limit`. */
  idPrefix?: string
  /** Maximum number of records, newest scheduled occurrence first. */
  limit?: number
  scheduleId?: string
}

export interface ScheduleRunStore {
  createAttempt: (attempt: ScheduleRunAttemptRecord) => Promise<ScheduleRunAttemptRecord> | ScheduleRunAttemptRecord
  createRun: (run: ScheduleRunRecord) => Promise<ScheduleRunRecord> | ScheduleRunRecord
  getAttempt: (id: string) => Promise<ScheduleRunAttemptRecord | undefined> | ScheduleRunAttemptRecord | undefined
  getRun: (id: string) => Promise<ScheduleRunRecord | undefined> | ScheduleRunRecord | undefined
  listAttempts: (runId: string) => Promise<ScheduleRunAttemptRecord[]> | ScheduleRunAttemptRecord[]
  /** Reads several histories using one request-scoped key snapshot when supported. */
  listRunsBatch?: (options: ScheduleRunListOptions[]) => Promise<ScheduleRunRecord[][]> | ScheduleRunRecord[][]
  listRuns: (options?: ScheduleRunListOptions) => Promise<ScheduleRunRecord[]> | ScheduleRunRecord[]
  updateAttempt: (id: string, patch: Partial<Pick<ScheduleRunAttemptRecord, "completedAt" | "error" | "status">> & { updatedAt: Date }) => Promise<ScheduleRunAttemptRecord | undefined> | ScheduleRunAttemptRecord | undefined
  updateRun: (id: string, patch: Partial<Pick<ScheduleRunRecord, "attemptCount" | "completedAt" | "error" | "response" | "startedAt" | "status">> & { updatedAt: Date }) => Promise<ScheduleRunRecord | undefined> | ScheduleRunRecord | undefined
}

export interface DiscoveredScheduleDefinition {
  manual?: boolean
  /** True when the Definition declares no `cron`, so it runs only when code starts it with `startSchedule()`. */
  startable?: boolean
  /** Plugin that contributed the Definition through `vitehub.schedules`. Only set for contributed Definitions. */
  contributor?: string
  handler: string
  name: string
  /** Why the plugin contributed the Definition. Only set for contributed Definitions. */
  reason?: string
  source?: "server-schedules" | "vite-plugin-contribution" | "vite-suffix"
}
import type { SerializedResponse } from "@vite-hub/runtime"

/** When a started Schedule runs: once at `at`, or on each occurrence of `cron` until you cancel it. */
export type StartScheduleTiming =
  | {
    /** One run at this time: a `Date`, or an ISO 8601 date-time with a time zone, such as `"2026-11-08T09:00:00Z"`. */
    at: Date | string
    cron?: never
    timeZone?: never
  }
  | {
    at?: never
    /** Five-field cron expression. The Schedule runs on each occurrence until you cancel it. */
    cron: string
    /** IANA time zone of `cron`, such as `"Europe/Madrid"`. Defaults to `"UTC"`. */
    timeZone?: string
  }

export type StartScheduleOptions = StartScheduleTiming & {
  /** JSON value that the handler receives as `context.payload`. */
  payload?: unknown
}

/** A Schedule that code started with `startSchedule()`. It stays in the store until its last run or `cancelSchedule()`. */
export interface StartedSchedule {
  /** One-time run. Absent for a cron Schedule. */
  at?: Date
  createdAt: Date
  cron?: string
  /** Pass it to `getSchedule()` and `cancelSchedule()`. Its runs use it as `scheduleId`. */
  id: string
  payload?: unknown
  /** Name of the Schedule Definition that runs. */
  name: string
  timeZone?: string
}

/** Stores the Schedules that code started. Records do not change after `put()`. */
export interface StartedScheduleStore {
  delete: (id: string) => Promise<boolean>
  get: (id: string) => Promise<StartedSchedule | undefined>
  list: () => Promise<StartedSchedule[]>
  put: (schedule: StartedSchedule) => Promise<void>
}
