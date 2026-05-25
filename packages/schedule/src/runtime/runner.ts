import { parseCronExpression } from "cron-schedule"

import { executeRuntimeSchedule } from "./execute.ts"
import { getRuntimeScheduleStore, getScheduleRunStore } from "./state.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, ScheduleRunStore } from "../types.ts"

export interface ScheduleRunnerController {
  readonly running: boolean
  stop: () => void
}

export interface ScheduleRunnerOptions {
  concurrency?: number
  intervalMs?: number
  now?: () => Date
  onError?: (error: unknown) => void
  runtimeScheduleStore?: RuntimeScheduleStore
  scheduleRunStore?: ScheduleRunStore
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONCURRENCY = 1

function floorUTCMinute(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  ))
}

function isDue(schedule: RuntimeScheduleRecord, scheduledAt: Date): boolean {
  const cron = parseCronExpression(schedule.cron)
  const minute = scheduledAt.getUTCMinutes()
  const hour = scheduledAt.getUTCHours()
  const day = scheduledAt.getUTCDate()
  const month = scheduledAt.getUTCMonth()
  const weekday = scheduledAt.getUTCDay()

  if (!cron.minutes.includes(minute) || !cron.hours.includes(hour) || !cron.months.includes(month)) {
    return false
  }
  if (cron.days.length !== 31 && cron.weekdays.length !== 7) {
    return cron.days.includes(day) || cron.weekdays.includes(weekday)
  }
  return cron.days.includes(day) && cron.weekdays.includes(weekday)
}

function toRunId(scheduleId: string, scheduledAt: Date): string {
  return `srun_${encodeURIComponent(scheduleId)}_${scheduledAt.toISOString()}`
}

function reportError(error: unknown, onError: ((error: unknown) => void) | undefined): void {
  if (!onError) {
    return
  }
  try {
    onError(error)
  }
  catch {
    // The runner owns error isolation; user error hooks must not crash scans.
  }
}

export function startScheduleRunner(options: ScheduleRunnerOptions = {}): ScheduleRunnerController {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("Schedule Runner intervalMs must be a positive number.")
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Schedule Runner concurrency must be a positive integer.")
  }

  const runtimeScheduleStore = options.runtimeScheduleStore ?? getRuntimeScheduleStore()
  const scheduleRunStore = options.scheduleRunStore ?? getScheduleRunStore()
  const now = options.now ?? (() => new Date())
  let stopped = false
  let active = 0
  const queuedRuns: Array<{ scheduledAt: Date, schedule: RuntimeScheduleRecord }> = []
  const queuedRunIds = new Set<string>()
  let scanning = false
  let timer: ReturnType<typeof setInterval> | undefined

  const pump = () => {
    while (!stopped && active < concurrency) {
      const next = queuedRuns.shift()
      if (!next) {
        return
      }
      dispatch(next.schedule, next.scheduledAt)
    }
  }

  const dispatch = (schedule: RuntimeScheduleRecord, scheduledAt: Date) => {
    active++
    void executeRuntimeSchedule({
      id: schedule.id,
      runtimeScheduleStore,
      scheduledAt,
      scheduleRunStore,
    })
      .catch(error => {
        reportError(error, options.onError)
      })
      .finally(() => {
        active--
        queuedRunIds.delete(toRunId(schedule.id, scheduledAt))
        pump()
      })
  }

  const scan = () => {
    if (stopped || scanning) {
      return
    }

    scanning = true
    void Promise.resolve().then(() => runtimeScheduleStore.list())
      .then(async schedules => {
        if (stopped) {
          return
        }
        const scheduledAt = floorUTCMinute(now())
        for (const schedule of schedules) {
          if (stopped) {
            return
          }
          let due = false
          try {
            due = isDue(schedule, scheduledAt)
          }
          catch (error) {
            reportError(error, options.onError)
            continue
          }
          if (!schedule.enabled || !due) {
            continue
          }
          const runId = toRunId(schedule.id, scheduledAt)
          if (queuedRunIds.has(runId) || await scheduleRunStore.getRun(runId)) {
            continue
          }
          queuedRunIds.add(runId)
          queuedRuns.push({ scheduledAt, schedule })
          pump()
        }
      })
      .catch(error => {
        reportError(error, options.onError)
      })
      .finally(() => {
        scanning = false
      })
  }

  timer = setInterval(scan, intervalMs)
  scan()

  return {
    get running() {
      return !stopped
    },
    stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}
