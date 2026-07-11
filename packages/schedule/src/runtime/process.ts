import { floorUTCMinute, isRuntimeScheduleDue } from "./due.ts"

import type { RuntimeScheduleRecord } from "../types.ts"
import type { RuntimeScheduleWakeDriverFactory } from "./driver.ts"

export interface ProcessScheduleWakeDriverOptions {
  concurrency?: number
  intervalMs?: number
  now?: () => Date
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONCURRENCY = 1

function validateOptions(options: ProcessScheduleWakeDriverOptions): { concurrency: number, intervalMs: number } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("Process Schedule Wake Driver intervalMs must be a positive number.")
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Process Schedule Wake Driver concurrency must be a positive integer.")
  }
  return { concurrency, intervalMs }
}

export function createProcessScheduleWakeDriver(options: ProcessScheduleWakeDriverOptions = {}): RuntimeScheduleWakeDriverFactory {
  return (context) => {
    const { concurrency, intervalMs } = validateOptions(options)
    const now = options.now ?? (() => new Date())
    let schedules: RuntimeScheduleRecord[] = []
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    let active = 0
    let occurrenceMinute: number | undefined
    const dispatched = new Set<string>()
    const queue: Array<{ scheduleId: string, scheduledAt: Date }> = []

    function reportError(error: unknown): void {
      try {
        context.reportError(error)
      }
      catch {}
    }

    function pump(): void {
      while (!closed && active < concurrency) {
        const input = queue.shift()
        if (!input) return
        active += 1
        void context.wake(input)
          .catch(reportError)
          .finally(() => {
            active -= 1
            pump()
          })
      }
    }

    function scan(): void {
      if (closed) return
      const scheduledAt = floorUTCMinute(now())
      const minute = scheduledAt.getTime()
      if (occurrenceMinute !== minute) {
        occurrenceMinute = minute
        dispatched.clear()
      }

      for (const schedule of schedules) {
        if (!schedule.enabled || dispatched.has(schedule.id)) continue
        let due = false
        try {
          due = isRuntimeScheduleDue(schedule, scheduledAt)
        }
        catch (error) {
          reportError(error)
          continue
        }
        if (!due) continue
        dispatched.add(schedule.id)
        queue.push({ scheduleId: schedule.id, scheduledAt })
      }
      pump()
    }

    return {
      close() {
        closed = true
        queue.length = 0
        if (timer) {
          clearInterval(timer)
          timer = undefined
        }
      },
      async reconcile(records) {
        if (closed) {
          throw new Error("Process Schedule Wake Driver is closed.")
        }
        const scheduledAt = floorUTCMinute(now())
        for (const record of records) {
          isRuntimeScheduleDue(record, scheduledAt)
        }
        const nextSchedules = records.map(record => ({ ...record }))
        const schedulesById = new Map(nextSchedules.map(schedule => [schedule.id, schedule]))
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const input = queue[index]!
          const schedule = schedulesById.get(input.scheduleId)
          if (schedule?.enabled && isRuntimeScheduleDue(schedule, input.scheduledAt)) continue
          queue.splice(index, 1)
          dispatched.delete(input.scheduleId)
        }
        schedules = nextSchedules
        timer ??= setInterval(scan, intervalMs)
        scan()
      },
    }
  }
}
