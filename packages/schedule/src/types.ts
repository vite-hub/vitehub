export interface ScheduleRunContext {
  id: string
  attemptId?: string
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: ScheduleTargetName
}

export type ScheduleHandler<TResult = unknown> = (context: ScheduleRunContext) => TResult | Promise<TResult>

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

export interface ScheduleDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ScheduleDefinition } | ScheduleDefinition>
}

export type ScheduleTargetName = string & {}

export interface RuntimeScheduleMetadata {
  createdAt: Date
  updatedAt: Date
}

export interface RuntimeScheduleRecord extends RuntimeScheduleMetadata {
  cron: string
  enabled: boolean
  id: string
  target: ScheduleTargetName
  timeZone?: string
}

export interface RuntimeScheduleCreateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> {
  cron: string
  enabled?: boolean
  id?: string
  target: TTarget
  timeZone?: string
}

export interface RuntimeScheduleUpdateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> {
  cron?: string
  enabled?: boolean
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
  source?: "server-schedules" | "vite-suffix"
}
