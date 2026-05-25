import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleUpdateInput } from "../types.ts"

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
        throw new Error(`Runtime Schedule already exists: ${record.id}`)
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

      const definedPatch = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as RuntimeScheduleUpdateInput & { updatedAt: Date }
      const next = cloneRuntimeSchedule({
        ...existing,
        ...definedPatch,
        updatedAt: definedPatch.updatedAt,
      })
      records.set(id, next)
      return cloneRuntimeSchedule(next)
    },
  }
}
