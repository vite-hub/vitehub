import { isRuntimeScheduleDue } from "./due.ts"

import type { RuntimeScheduleRecord } from "../types.ts"
import type { RuntimeScheduleWakeDriverFactory } from "./driver.ts"

export interface ProcessScheduleWakeDriverOptions {
  concurrency?: number
  intervalMs?: number
  now?: () => Date
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

function validateOptions(options: ProcessScheduleWakeDriverOptions): { concurrency: number, intervalMs: number } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > DEFAULT_INTERVAL_MS) {
    throw new TypeError("Process Schedule Wake Driver intervalMs must be a positive number no greater than 60000.")
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
    let occurrenceMinute: number | undefined
    const dispatched = new Set<string>()
    const queue: Array<{ scheduleId: string, scheduledAt: Date }> = []
    const activeOccurrences = new Set<string>()
    const activeWakes = new Set<Promise<void>>()

    function occurrenceKey(input: { scheduleId: string, scheduledAt: Date }): string {
      return `${input.scheduleId}:${input.scheduledAt.getTime()}`
    }

    function reportError(error: unknown): void {
      try {
        context.reportError(error)
      }
      catch {}
    }

    function pump(): void {
      while (!closed && activeWakes.size < concurrency) {
        const input = queue.shift()
        if (!input) return
        const key = occurrenceKey(input)
        activeOccurrences.add(key)
        let wakePromise: Promise<void>
        wakePromise = context.wake(input)
          .catch(reportError)
          .finally(() => {
            activeOccurrences.delete(key)
            activeWakes.delete(wakePromise)
            pump()
          })
        activeWakes.add(wakePromise)
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
      async close() {
        closed = true
        queue.length = 0
        if (timer) {
          clearInterval(timer)
          timer = undefined
        }
        await Promise.allSettled(activeWakes)
      },
      async reconcile(records) {
        if (closed) {
          throw new Error("Process Schedule Wake Driver is closed.")
        }
        const scheduledAt = floorUTCMinute(now())
        for (const record of records) {
          if (!record.enabled) continue
          isRuntimeScheduleDue(record, scheduledAt)
        }
        const nextSchedules = records.map(record => ({ ...record }))
        const schedulesById = new Map(nextSchedules.map(schedule => [schedule.id, schedule]))
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          const input = queue[index]!
          const schedule = schedulesById.get(input.scheduleId)
          if (schedule?.enabled && isRuntimeScheduleDue(schedule, input.scheduledAt)) continue
          queue.splice(index, 1)
          if (
            input.scheduledAt.getTime() === occurrenceMinute
            && !queue.some(queued => queued.scheduleId === input.scheduleId && queued.scheduledAt.getTime() === occurrenceMinute)
            && !activeOccurrences.has(occurrenceKey(input))
          ) {
            dispatched.delete(input.scheduleId)
          }
        }
        schedules = nextSchedules
        timer ??= setInterval(scan, intervalMs)
        scan()
      },
    }
  }
}
