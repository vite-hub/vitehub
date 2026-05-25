import type { ScheduleDefinition, ScheduleRunContext } from "../types.ts"

export interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
}

export interface ScheduleRun extends ScheduleRunContext {
  cron: string
  scheduleId: string
}

export function createScheduleRun(options: Omit<ExecuteStaticScheduleOptions, "definition">): ScheduleRun {
  const scheduledAt = options.scheduledAt ?? new Date()
  return {
    cron: options.cron,
    id: `run_${options.name}_${scheduledAt.toISOString()}`,
    scheduleId: options.name,
    scheduledAt,
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<unknown> {
  const run = createScheduleRun(options)
  return await options.definition.handler(run)
}
