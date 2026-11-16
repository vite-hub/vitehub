import { isScheduleDue } from "../runtime/due.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

import type { ScheduleCronRecord } from "../runtime/due.ts"
import type { ProcessScheduleRuntimeOptions } from "../runtime/process.ts"

/** One Static Schedule that the process checks each minute. */
export type ProcessScheduleEntry = ScheduleCronRecord

/** One due occurrence of a Static Schedule. */
export interface ProcessScheduleWake {
  scheduleId: string
  scheduledAt: Date
}

export interface ProcessWakeContext {
  /** Newest cron-triggered run time, `undefined` when none exists, or `"unknown"` to check the full catch-up window when legacy history is inconclusive. */
  latestScheduledAt?(scheduleId: string): Promise<Date | "unknown" | undefined>
  /** Occurrences held by another process or awaiting a lease-store retry. */
  retries?(): readonly ProcessScheduleWake[]
  reportError(error: unknown): void
  wake(input: ProcessScheduleWake): Promise<void>
}

export type ProcessWakeDriverOptions = Pick<ProcessScheduleRuntimeOptions, "catchUpMs" | "concurrency" | "intervalMs" | "now">

export interface ProcessWakeDriver {
  close(): Promise<void>
  reconcile(entries: readonly ProcessScheduleEntry[]): Promise<void>
}

const minuteMs = 60_000
const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONCURRENCY = 1
export const DEFAULT_CATCH_UP_MS = 60 * 60_000

function validateDriverOptions(options: ProcessWakeDriverOptions): { catchUpMs: number, concurrency: number, intervalMs: number } {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS
  if (!Number.isFinite(catchUpMs) || catchUpMs < 0) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0024({ message: "Process Schedule Runtime catchUpMs must be a finite number of zero or more." })
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > DEFAULT_INTERVAL_MS) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0024({ message: "Process Schedule Runtime intervalMs must be a positive number no greater than 60000." })
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0025({ message: "Process Schedule Runtime concurrency must be a positive integer." })
  }
  return { catchUpMs, concurrency, intervalMs }
}

function floorUTCMinute(date: Date): number {
  return Math.floor(date.getTime() / minuteMs) * minuteMs
}

function occurrenceKey(input: ProcessScheduleWake): string {
  return `${input.scheduleId}:${input.scheduledAt.getTime()}`
}

function byScheduledAt(left: ProcessScheduleWake, right: ProcessScheduleWake): number {
  return left.scheduledAt.getTime() - right.scheduledAt.getTime()
}

/**
 * Creates the in-process minute scanner. `reconcile()` replaces the checked Schedules and starts the scanner on the
 * first call. `close()` stops the scanner and waits for active wakes. Timers do not keep the process alive.
 */
export function createProcessWakeDriver(options: ProcessWakeDriverOptions, context: ProcessWakeContext): ProcessWakeDriver {
  const { catchUpMs, concurrency, intervalMs } = validateDriverOptions(options)
  const now = options.now ?? (() => new Date(Date.now()))

  let schedules = new Map<string, ProcessScheduleEntry>()
  /** Occurrences waiting for a worker, in delivery order. */
  const queued = new Map<string, ProcessScheduleWake>()
  /** Occurrences that a worker is waking now. */
  const active = new Set<string>()
  /** Schedules already queued for `occurrenceMinute`, so a Schedule wakes once per current minute. */
  let dispatched = new Set<string>()
  let occurrenceMinute: number | undefined
  let scannedThrough: number | undefined
  let started = false
  let closing = false
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let workers = 0
  let onIdle: (() => void) | undefined
  let closePromise: Promise<void> | undefined

  // Reconcile, scans and the start of close run one at a time. Only the first reconcile awaits, during catch-up.
  let lock: Promise<unknown> = Promise.resolve()
  function exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = lock.then(operation)
    lock = result.then(() => {}, () => {})
    return result
  }

  function reportError(error: unknown): void {
    try {
      context.reportError(error)
    }
    catch {}
  }

  function take(): ProcessScheduleWake | undefined {
    for (const [key, input] of queued) {
      queued.delete(key)
      // Completion markers outlast this window. Old queued work must not run after its marker can expire.
      if (input.scheduledAt.getTime() < floorUTCMinute(now()) - catchUpMs) continue
      return input
    }
    return undefined
  }

  async function work(): Promise<void> {
    try {
      for (let input = take(); input; input = take()) {
        const key = occurrenceKey(input)
        active.add(key)
        try {
          await context.wake(input)
        }
        catch (error) {
          reportError(error)
        }
        finally {
          active.delete(key)
        }
      }
    }
    finally {
      workers -= 1
      if (workers === 0) onIdle?.()
    }
  }

  /** Starts workers up to `concurrency`. A free worker starts its wake before this returns. */
  function startWorkers(): void {
    while (workers < concurrency && queued.size > 0) {
      workers += 1
      void work()
    }
  }

  /** Due occurrences of `entries` from `first` through `last`, oldest first. */
  function dueOccurrences(entries: Iterable<ProcessScheduleEntry>, first: number, last: number): ProcessScheduleWake[] {
    const due: ProcessScheduleWake[] = []
    for (const schedule of entries) {
      for (let minute = Math.ceil(first / minuteMs) * minuteMs; minute <= last; minute += minuteMs) {
        const scheduledAt = new Date(minute)
        let isDue: boolean
        try {
          isDue = isScheduleDue(schedule, scheduledAt)
        }
        catch (error) {
          reportError(error)
          break
        }
        if (isDue) due.push({ scheduleId: schedule.id, scheduledAt })
      }
    }
    return due.sort(byScheduledAt)
  }

  /** Queues occurrences that are not queued or running yet, then starts free workers. The current minute dispatches each Schedule once. */
  function enqueue(due: readonly ProcessScheduleWake[], currentMinute: number, retries: readonly ProcessScheduleWake[] = []): void {
    if (closing) return
    // A wall-clock correction can move the process into an earlier minute. Do not
    // reset the per-minute deduplication state, or that minute may run twice when
    // the clock moves forward again.
    if (occurrenceMinute !== undefined && currentMinute < occurrenceMinute) return
    if (occurrenceMinute !== currentMinute) dispatched = new Set()
    for (const input of due) {
      const key = occurrenceKey(input)
      if (queued.has(key) || active.has(key)) continue
      if (input.scheduledAt.getTime() === currentMinute) {
        if (dispatched.has(input.scheduleId)) continue
        dispatched.add(input.scheduleId)
      }
      queued.set(key, input)
    }
    for (const input of retries) {
      const key = occurrenceKey(input)
      const schedule = schedules.get(input.scheduleId)
      if (!schedule || queued.has(key) || active.has(key) || !isScheduleDue(schedule, input.scheduledAt)) continue
      queued.set(key, input)
    }
    occurrenceMinute = currentMinute
    scannedThrough = Math.max(scannedThrough ?? currentMinute, currentMinute)
    startWorkers()
  }

  function scan(): void {
    const currentMinute = floorUTCMinute(now())
    // A late timer can skip a minute. Check every minute after the previous scan.
    const first = scannedThrough === undefined
      ? currentMinute
      : Math.min(currentMinute, Math.max(scannedThrough + minuteMs, currentMinute - catchUpMs))
    // Claims can be held, or the store unavailable, after the scan advances. Retry those occurrences on later scans.
    enqueue(dueOccurrences(schedules.values(), first, currentMinute), currentMinute, context.retries?.() ?? [])
  }

  // After a restart, dispatch the minutes that no process checked: those after each Schedule's
  // latest run, within `catchUpMs`. Run ids are deterministic, so a minute that already ran does not run again.
  async function catchUp(entries: readonly ProcessScheduleEntry[]): Promise<void> {
    if (!context.latestScheduledAt || catchUpMs <= 0) return
    const currentMinute = floorUTCMinute(now())
    const due: ProcessScheduleWake[] = []
    for (const schedule of entries) {
      let latest: Date | "unknown" | undefined
      try {
        latest = await context.latestScheduledAt(schedule.id)
      }
      catch (error) {
        reportError(error)
      }
      if (!latest) continue
      const first = latest === "unknown"
        ? currentMinute - catchUpMs
        : Math.max(floorUTCMinute(latest) + minuteMs, currentMinute - catchUpMs)
      due.push(...dueOccurrences([schedule], first, currentMinute - minuteMs))
    }
    enqueue(due.sort(byScheduledAt), currentMinute)
  }

  async function reconcile(records: readonly ProcessScheduleEntry[]): Promise<void> {
    // Validate every cron before the checked Schedules change.
    const scheduledAt = new Date(floorUTCMinute(now()))
    for (const record of records) isScheduleDue(record, scheduledAt)

    const next = new Map(records.map(record => [record.id, { ...record }]))
    for (const [key, input] of queued) {
      const schedule = next.get(input.scheduleId)
      if (schedule && isScheduleDue(schedule, input.scheduledAt)) continue
      queued.delete(key)
      if (occurrenceMinute === input.scheduledAt.getTime() && !active.has(key)) dispatched.delete(input.scheduleId)
    }
    schedules = next

    if (closing) return
    const startScanner = !started
    if (startScanner) await catchUp(records)
    scan()
    if (startScanner) {
      timer = setInterval(() => {
        exclusive(() => {
          if (!closing) scan()
        }).catch(reportError)
      }, intervalMs)
      timer.unref?.()
      started = true
    }
  }

  async function close(): Promise<void> {
    await exclusive(() => {
      closing = true
      queued.clear()
      clearInterval(timer)
    })
    if (workers > 0) await new Promise<void>((resolve) => { onIdle = resolve })
    closed = true
  }

  return {
    close() {
      return closePromise ??= close()
    },
    reconcile(entries) {
      if (closed) return Promise.reject(scheduleErrorDiagnostics.SCHEDULE_R0026({ message: "Process Schedule Runtime is closed." }))
      return exclusive(() => reconcile(entries))
    },
  }
}
