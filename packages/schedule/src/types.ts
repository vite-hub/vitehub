export interface ScheduleRunContext {
  id: string
  attemptId?: string
  /**
   * Stable key of this occurrence: `schedule:<name>:<scheduledAt ISO>`. A host that delivers one cron wake twice gives
   * both runs the same key. Pass it as `idempotencyKey` to Queue, Email, or a Channel so the work happens once.
   */
  idempotencyKey: string
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
  /** Allows `runSchedule()`, the Console, and `vitehub schedule run` to start this definition outside its cron. */
  manual?: boolean
  /** Five-field cron expression, evaluated in `timeZone`. */
  cron: string
  handler: ScheduleHandler<TResult>
  /**
   * IANA time zone of `cron`, such as `"Europe/Madrid"`. Defaults to `"UTC"`. Every host follows daylight saving time:
   * a skipped local time runs once, shifted by the gap, and a repeated local time runs once. For host cron output
   * (Cloudflare, Vercel, Netlify, Deno), write it as a string literal so the build can read it.
   */
  timeZone?: string
}

export interface ScheduleDefinitionOptions {
  /** Allows `runSchedule()`, the Console, and `vitehub schedule run` to start this definition outside its cron. */
  manual?: boolean
  /** IANA time zone of the cron, such as `"Europe/Madrid"`. Defaults to `"UTC"`. */
  timeZone?: string
}

export interface ScheduleDefinition<TResult = unknown> {
  cron: string
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
  /** Plugin that contributed the Definition through `vitehub.schedules`. Only set for contributed Definitions. */
  contributor?: string
  handler: string
  name: string
  /** Why the plugin contributed the Definition. Only set for contributed Definitions. */
  reason?: string
  source?: "server-schedules" | "vite-plugin-contribution" | "vite-suffix"
}
import type { SerializedResponse } from "@vite-hub/runtime"
