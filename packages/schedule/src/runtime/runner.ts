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
  const utcWallClockMinute = new Date(
    scheduledAt.getUTCFullYear(),
    scheduledAt.getUTCMonth(),
    scheduledAt.getUTCDate(),
    scheduledAt.getUTCHours(),
    scheduledAt.getUTCMinutes(),
  )
  return parseCronExpression(schedule.cron).matchDate(utcWallClockMinute)
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
  let scanning = false
  let timer: ReturnType<typeof setInterval> | undefined

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
      })
  }

  const scan = () => {
    if (stopped || scanning || active >= concurrency) {
      return
    }

    scanning = true
    void Promise.resolve(runtimeScheduleStore.list())
      .then(async schedules => {
        if (stopped) {
          return
        }
        const scheduledAt = floorUTCMinute(now())
        for (const schedule of schedules) {
          if (stopped || active >= concurrency) {
            return
          }
          if (!schedule.enabled || !isDue(schedule, scheduledAt)) {
            continue
          }
          if (await scheduleRunStore.getRun(toRunId(schedule.id, scheduledAt))) {
            continue
          }
          if (!stopped && active < concurrency) {
            dispatch(schedule, scheduledAt)
          }
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
