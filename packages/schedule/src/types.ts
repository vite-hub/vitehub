export interface ScheduleRunContext {
  id: string
  scheduledAt: Date
}

export type ScheduleHandler<TResult = unknown> = (context: ScheduleRunContext) => TResult | Promise<TResult>

export interface ScheduleDefinitionInput<TResult = unknown> {
  cron: string
  handler: ScheduleHandler<TResult>
}

export interface ScheduleDefinition<TResult = unknown> {
  cron: string
  handler: ScheduleHandler<TResult>
}

export interface ScheduleDefinitionRegistry {
  [name: string]: () => Promise<{ default?: ScheduleDefinition } | ScheduleDefinition>
}

export interface DiscoveredScheduleDefinition {
  handler: string
  name: string
  source?: "nitro-server-schedules" | "vite-suffix"
}
