import { ScheduleError } from "../errors.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleUpdateInput, ScheduleRunAttemptRecord, ScheduleRunRecord, ScheduleRunStore } from "../types.ts"

function cloneRuntimeSchedule(record: RuntimeScheduleRecord): RuntimeScheduleRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }
}

export function createMemoryRuntimeScheduleStore(): RuntimeScheduleStore {
  const records = new Map<string, RuntimeScheduleRecord>()

  return {
    create(record) {
      if (records.has(record.id)) {
        throw new ScheduleError(`Runtime Schedule already exists: ${record.id}`, {
          code: "SCHEDULE_ALREADY_EXISTS",
          details: { id: record.id },
          httpStatus: 409,
        })
      }
      records.set(record.id, cloneRuntimeSchedule(record))
      return cloneRuntimeSchedule(record)
    },
    delete(id) {
      return records.delete(id)
    },
    get(id) {
      const record = records.get(id)
      return record ? cloneRuntimeSchedule(record) : undefined
    },
    list() {
      return [...records.values()].map(cloneRuntimeSchedule)
    },
    update(id: string, patch: RuntimeScheduleUpdateInput & { updatedAt: Date }) {
      const existing = records.get(id)
      if (!existing) {
        return undefined
      }

      const next = cloneRuntimeSchedule({
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt,
      })
      records.set(id, next)
      return cloneRuntimeSchedule(next)
    },
  }
}

function cloneScheduleRun(record: ScheduleRunRecord): ScheduleRunRecord {
  return {
    ...record,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    createdAt: new Date(record.createdAt),
    scheduledAt: new Date(record.scheduledAt),
    error: record.error ? { ...record.error } : undefined,
    startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
    updatedAt: new Date(record.updatedAt),
  }
}

function cloneScheduleRunAttempt(record: ScheduleRunAttemptRecord): ScheduleRunAttemptRecord {
  return {
    ...record,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    createdAt: new Date(record.createdAt),
    error: record.error ? { ...record.error } : undefined,
    startedAt: new Date(record.startedAt),
    updatedAt: new Date(record.updatedAt),
  }
}

export function createMemoryScheduleRunStore(): ScheduleRunStore {
  const runs = new Map<string, ScheduleRunRecord>()
  const attempts = new Map<string, ScheduleRunAttemptRecord>()

  return {
    createAttempt(attempt) {
      if (attempts.has(attempt.id)) {
        throw new Error(`Schedule Run Attempt already exists: ${attempt.id}`)
      }
      attempts.set(attempt.id, cloneScheduleRunAttempt(attempt))
      return cloneScheduleRunAttempt(attempt)
    },
    createRun(run) {
      if (runs.has(run.id)) {
        throw new Error(`Schedule Run already exists: ${run.id}`)
      }
      runs.set(run.id, cloneScheduleRun(run))
      return cloneScheduleRun(run)
    },
    getAttempt(id) {
      const attempt = attempts.get(id)
      return attempt ? cloneScheduleRunAttempt(attempt) : undefined
    },
    getRun(id) {
      const run = runs.get(id)
      return run ? cloneScheduleRun(run) : undefined
    },
    listAttempts(runId) {
      return [...attempts.values()]
        .filter(attempt => attempt.runId === runId)
        .map(cloneScheduleRunAttempt)
    },
    listRuns() {
      return [...runs.values()].map(cloneScheduleRun)
    },
    updateAttempt(id, patch) {
      const existing = attempts.get(id)
      if (!existing) {
        return undefined
      }
      const next = cloneScheduleRunAttempt({
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt,
      })
      attempts.set(id, next)
      return cloneScheduleRunAttempt(next)
    },
    updateRun(id, patch) {
      const existing = runs.get(id)
      if (!existing) {
        return undefined
      }
      const next = cloneScheduleRun({
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt,
      })
      runs.set(id, next)
      return cloneScheduleRun(next)
    },
  }
}
