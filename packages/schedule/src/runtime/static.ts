import type { ScheduleDefinition, ScheduleRunContext } from "../types.ts"

export interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
}

export interface StaticScheduleRun extends ScheduleRunContext {
  cron: string
  scheduleId: string
}

export function createStaticScheduleRun(options: Omit<ExecuteStaticScheduleOptions, "definition">): StaticScheduleRun {
  const scheduledAt = options.scheduledAt ?? new Date()
  return {
    cron: options.cron,
    id: `run_${options.name}_${scheduledAt.toISOString()}`,
    scheduleId: options.name,
    scheduledAt,
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<unknown> {
  return await options.definition.handler(createStaticScheduleRun(options))
}
