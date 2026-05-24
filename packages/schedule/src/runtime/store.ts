import { ScheduleError } from "../errors.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleUpdateInput } from "../types.ts"

function cloneRuntimeSchedule(record: RuntimeScheduleRecord): RuntimeScheduleRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }
}

function omitUndefinedPatch(patch: RuntimeScheduleUpdateInput): RuntimeScheduleUpdateInput {
  return {
    ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.target !== undefined ? { target: patch.target } : {}),
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
        ...omitUndefinedPatch(patch),
        updatedAt: patch.updatedAt,
      })
      records.set(id, next)
      return cloneRuntimeSchedule(next)
    },
  }
}
