import { randomId } from "@vite-hub/internal/runtime/random"
import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"
import { isRecordOrFunction as isPlainObject } from "@vite-hub/internal/object"
import { parseCronExpression } from "cron-schedule"

import { parseScheduledAt } from "./runtime/date.ts"
import { getStartedScheduleRuntime } from "./runtime/state.ts"
import { startedScheduleErrors } from "./started-errors.ts"

import type { Result } from "@vite-hub/runtime"
import type { StartedScheduleRuntime } from "./runtime/state.ts"
import type { StartedScheduleErrorCode } from "./started-errors.ts"
import type { StartedSchedule, StartScheduleOptions } from "./types.ts"

const optionKeys = new Set(["at", "cron", "payload", "timeZone"])

function isString(value: unknown): value is string {
  return String(value) === value
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  switch (typeof value) {
    case "string":
    case "boolean": return true
    case "number": return Number.isFinite(value)
    case "object": {
      if (value === null) return true
      if (ancestors.has(value)) return false
      const prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
      if (Object.getOwnPropertySymbols(value).length) return false
      ancestors.add(value)
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) return false
          }
          return true
        }
        return Object.values(value).every(entry => isJsonValue(entry, ancestors))
      }
      finally {
        ancestors.delete(value)
      }
    }
    default: return false
  }
}

function invalid(problem: string): Result<never, StartedScheduleErrorCode> {
  return [startedScheduleErrors.SCHEDULE_INVALID_OPTIONS({ problem }), undefined]
}

function isFiveFieldCron(cron: string): boolean {
  if (cron.trim() !== cron || cron.split(/\s+/).length !== 5) return false
  try {
    parseCronExpression(cron)
    return true
  }
  catch {
    return false
  }
}

/** Reads the options once at the boundary. The returned record is what the store keeps. */
function parseOptions(name: string, options: unknown): Result<StartedSchedule, StartedScheduleErrorCode> {
  if (!isPlainObject(options)) return invalid("pass an object with `at` or `cron`.")
  const unknownKey = Object.keys(options).find(key => !optionKeys.has(key))
  if (unknownKey) return invalid(`\`${unknownKey}\` is not an option.`)
  const { at, cron, payload, timeZone } = options
  if ((at === undefined) === (cron === undefined)) return invalid("pass `at` for one run or `cron` for a repeating Schedule, not both and not neither.")

  const schedule: StartedSchedule = { createdAt: new Date(), id: randomId("sched"), name }
  if (at !== undefined) {
    if (timeZone !== undefined) return invalid("`timeZone` applies to `cron`. Give `at` as an ISO 8601 date-time with its offset instead.")
    try {
      // SAFETY: parseScheduledAt() accepts unknown values and throws for anything other than a Date or a zoned ISO string.
      schedule.at = parseScheduledAt(at as Date | string)
    }
    catch {
      return invalid("`at` must be a Date or an ISO 8601 date-time with a time zone, such as \"2026-11-08T09:00:00Z\".")
    }
  }
  else {
    if (!isString(cron) || !isFiveFieldCron(cron)) return invalid("`cron` must be a five-field cron expression, such as \"0 9 * * 1-5\".")
    schedule.cron = cron
    if (timeZone !== undefined) {
      if (!isIanaTimeZone(timeZone)) return invalid("`timeZone` must be an IANA time zone, such as \"Europe/Madrid\".")
      schedule.timeZone = timeZone
    }
  }
  if (payload !== undefined) {
    let text: string | undefined
    try {
      if (!isJsonValue(payload)) return invalid("`payload` must be a JSON value.")
      text = JSON.stringify(payload)
    }
    catch {
      text = undefined
    }
    if (text === undefined) return invalid("`payload` must be a JSON value.")
    schedule.payload = JSON.parse(text)
  }
  return [undefined, schedule]
}

function requireRuntime(): Result<StartedScheduleRuntime, StartedScheduleErrorCode> {
  const runtime = getStartedScheduleRuntime()
  return runtime ? [undefined, runtime] : [startedScheduleErrors.SCHEDULE_STORE_MISSING(), undefined]
}

async function fromStore<T>(work: () => Promise<T>): Promise<Result<T, StartedScheduleErrorCode>> {
  try {
    return [undefined, await work()]
  }
  catch (cause) {
    return [startedScheduleErrors.SCHEDULE_STORE_FAILED({ cause }), undefined]
  }
}

/**
 * Starts the Schedule Definition `name`, which declares no `cron`, at a time that code picks: once at `at`, or on each
 * occurrence of `cron` in `timeZone` until `cancelSchedule()`. The store keeps it across restarts and deploys. The handler
 * receives `payload` as `context.payload`.
 */
export async function startSchedule(name: string, options: StartScheduleOptions): Promise<Result<StartedSchedule, StartedScheduleErrorCode>> {
  const [missing, runtime] = requireRuntime()
  if (missing) return [missing, undefined]
  if (!isString(name) || !Object.hasOwn(runtime.registry, name)) {
    return [startedScheduleErrors.SCHEDULE_NOT_STARTABLE({ name: String(name) }), undefined]
  }
  const [error, schedule] = parseOptions(name, options)
  if (error) return [error, undefined]
  const [storeError] = await fromStore(() => runtime.store.put(schedule))
  return storeError ? [storeError, undefined] : [undefined, schedule]
}

/** Reads one started Schedule. */
export async function getSchedule(id: string): Promise<Result<StartedSchedule, StartedScheduleErrorCode>> {
  const [missing, runtime] = requireRuntime()
  if (missing) return [missing, undefined]
  const [error, schedule] = await fromStore(() => runtime.store.get(id))
  if (error) return [error, undefined]
  return schedule ? [undefined, schedule] : [startedScheduleErrors.SCHEDULE_NOT_FOUND({ id: String(id) }), undefined]
}

/** Lists the started Schedules, oldest first. `name` keeps the Schedules of one Definition. */
export async function listSchedules(options: { name?: string } = {}): Promise<Result<StartedSchedule[], StartedScheduleErrorCode>> {
  const [missing, runtime] = requireRuntime()
  if (missing) return [missing, undefined]
  const [error, schedules] = await fromStore(() => runtime.store.list())
  if (error) return [error, undefined]
  return [undefined, schedules
    .filter(schedule => options.name === undefined || schedule.name === options.name)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())]
}

/** Removes a started Schedule, so it does not run again. A run that already started finishes. */
export async function cancelSchedule(id: string): Promise<Result<StartedSchedule, StartedScheduleErrorCode>> {
  const [error, schedule] = await getSchedule(id)
  if (error) return [error, undefined]
  const [missing, runtime] = requireRuntime()
  if (missing) return [missing, undefined]
  const [storeError, deleted] = await fromStore(() => runtime.store.delete(id))
  if (storeError) return [storeError, undefined]
  return deleted ? [undefined, schedule] : [startedScheduleErrors.SCHEDULE_NOT_FOUND({ id: String(id) }), undefined]
}
