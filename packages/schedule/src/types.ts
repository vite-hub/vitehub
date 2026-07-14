export interface ScheduleRunContext<TInput = unknown> {
  id: string
  attemptId?: string
  input?: TInput
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: ScheduleTargetName
  waitUntil(promise: PromiseLike<unknown>): void
}

export type ScheduleHandler<TResult = unknown, TInput = unknown> = {
  bivarianceHack(context: ScheduleRunContext<TInput>): TResult | Promise<TResult>
}["bivarianceHack"]

export interface ScheduleDefinitionInput<TResult = unknown> {
  allowRuntimeSchedules?: boolean
  cron: string
  handler: ScheduleHandler<TResult>
}

export interface ScheduleDefinitionOptions {
  allowRuntimeSchedules?: boolean
}

export interface ScheduleDefinition<TResult = unknown> {
  cron: string
  handler: ScheduleHandler<TResult>
  options?: ScheduleDefinitionOptions
}

export interface ScheduleTargetDefinitionInput<TInput = unknown, TResult = unknown> {
  handler: ScheduleHandler<TResult, TInput>
}

export interface ScheduleTargetDefinition<TInput = unknown, TResult = unknown> {
  handler: ScheduleHandler<TResult, TInput>
  options: {
    allowRuntimeSchedules: true
  }
}

export type ScheduleRegistryDefinition = ScheduleDefinition | ScheduleTargetDefinition

export interface ScheduleDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ScheduleRegistryDefinition } | ScheduleRegistryDefinition>
}

export type ScheduleTargetName = string & {}

export interface RuntimeScheduleMetadata {
  createdAt: Date
  updatedAt: Date
}

export interface RuntimeScheduleRecord<TInput = unknown> extends RuntimeScheduleMetadata {
  cron: string
  enabled: boolean
  id: string
  input?: TInput
  target: ScheduleTargetName
  timeZone?: string
}

export interface RuntimeScheduleWake {
  scheduleId: string
  scheduledAt: Date
}

export interface RuntimeScheduleCreateInput<TTarget extends ScheduleTargetName = ScheduleTargetName, TInput = unknown> {
  cron: string
  enabled?: boolean
  id?: string
  input?: TInput
  target: TTarget
  timeZone?: string
}

export interface RuntimeScheduleUpdateInput<TTarget extends ScheduleTargetName = ScheduleTargetName, TInput = unknown> {
  cron?: string
  enabled?: boolean
  input?: TInput
  target?: TTarget
  timeZone?: string
}

export interface RuntimeScheduleStore {
  create: (record: RuntimeScheduleRecord) => Promise<RuntimeScheduleRecord> | RuntimeScheduleRecord
  delete: (id: string) => Promise<boolean> | boolean
  get: (id: string) => Promise<RuntimeScheduleRecord | undefined> | RuntimeScheduleRecord | undefined
  list: () => Promise<RuntimeScheduleRecord[]> | RuntimeScheduleRecord[]
  update: (id: string, patch: RuntimeScheduleUpdateInput & { updatedAt: Date }) => Promise<RuntimeScheduleRecord | undefined> | RuntimeScheduleRecord | undefined
}

export type ScheduleRunStatus = "pending" | "running" | "succeeded" | "failed"

export type ScheduleRunAttemptStatus = "running" | "succeeded" | "failed"

export interface ScheduleRunError {
  message: string
  name?: string
  stack?: string
}

export interface ScheduleRunRecord {
  attemptCount: number
  completedAt?: Date
  createdAt: Date
  error?: ScheduleRunError
  id: string
  scheduleId: string
  scheduledAt: Date
  startedAt?: Date
  status: ScheduleRunStatus
  target: ScheduleTargetName
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

export interface ScheduleRunStore {
  createAttempt: (attempt: ScheduleRunAttemptRecord) => Promise<ScheduleRunAttemptRecord> | ScheduleRunAttemptRecord
  createRun: (run: ScheduleRunRecord) => Promise<ScheduleRunRecord> | ScheduleRunRecord
  getAttempt: (id: string) => Promise<ScheduleRunAttemptRecord | undefined> | ScheduleRunAttemptRecord | undefined
  getRun: (id: string) => Promise<ScheduleRunRecord | undefined> | ScheduleRunRecord | undefined
  listAttempts: (runId: string) => Promise<ScheduleRunAttemptRecord[]> | ScheduleRunAttemptRecord[]
  listRuns: () => Promise<ScheduleRunRecord[]> | ScheduleRunRecord[]
  updateAttempt: (id: string, patch: Partial<Pick<ScheduleRunAttemptRecord, "completedAt" | "error" | "status">> & { updatedAt: Date }) => Promise<ScheduleRunAttemptRecord | undefined> | ScheduleRunAttemptRecord | undefined
  updateRun: (id: string, patch: Partial<Pick<ScheduleRunRecord, "attemptCount" | "completedAt" | "error" | "startedAt" | "status">> & { updatedAt: Date }) => Promise<ScheduleRunRecord | undefined> | ScheduleRunRecord | undefined
}

export interface DiscoveredScheduleDefinition {
  allowRuntimeSchedules?: boolean
  handler: string
  name: string
  runtimeOnly?: boolean
  source?: "server-schedules" | "vite-suffix"
}
