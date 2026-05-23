export interface ScheduleRunContext {
  id: string
  scheduledAt: Date
}

export type ScheduleHandler<TResult = unknown> = (context: ScheduleRunContext) => TResult | Promise<TResult>

export interface ScheduleDefinitionOptions {
  allowRuntimeSchedules?: boolean
  id?: string
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
}

export interface RuntimeScheduleCreateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> {
  cron: string
  enabled?: boolean
  id?: string
  target: TTarget
}

export interface RuntimeScheduleUpdateInput<TTarget extends ScheduleTargetName = ScheduleTargetName> {
  cron?: string
  enabled?: boolean
  target?: TTarget
}

export interface RuntimeScheduleStore {
  create: (record: RuntimeScheduleRecord) => Promise<RuntimeScheduleRecord> | RuntimeScheduleRecord
  delete: (id: string) => Promise<boolean> | boolean
  get: (id: string) => Promise<RuntimeScheduleRecord | undefined> | RuntimeScheduleRecord | undefined
  list: () => Promise<RuntimeScheduleRecord[]> | RuntimeScheduleRecord[]
  update: (id: string, patch: RuntimeScheduleUpdateInput & { updatedAt: Date }) => Promise<RuntimeScheduleRecord | undefined> | RuntimeScheduleRecord | undefined
}

export interface DiscoveredScheduleDefinition {
  allowRuntimeSchedules?: boolean
  handler: string
  name: string
  source?: "nitro-server-schedules" | "vite-suffix"
}
