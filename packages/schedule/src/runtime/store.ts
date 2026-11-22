import type { ScheduleRunAttemptRecord, ScheduleRunRecord, ScheduleRunListOptions, ScheduleRunStore } from "../types.ts"
import type { ScheduleKVStorage } from "./kv-storage.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

export interface KVScheduleStoreOptions {
  kvStore: ScheduleKVStorage
  prefix?: string
}

type StoredScheduleRunRecord = Omit<ScheduleRunRecord, "completedAt" | "createdAt" | "scheduledAt" | "startedAt" | "updatedAt"> & {
  completedAt?: string
  createdAt: string
  scheduledAt: string
  startedAt?: string
  updatedAt: string
}

type StoredScheduleRunAttemptRecord = Omit<ScheduleRunAttemptRecord, "completedAt" | "createdAt" | "startedAt" | "updatedAt"> & {
  completedAt?: string
  createdAt: string
  startedAt: string
  updatedAt: string
}

function trimPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "")
}

/**
 * Decoded trailing segments of a listed key. Some KV stores, such as unstorage, list keys with `:` instead of `/`.
 * Encoded parts contain neither, so both separators are safe to split on.
 */
export function keySegments(key: string, count: number): string[] {
  return key.split(/[/:]/).slice(-count).map(decodeURIComponent)
}

export function joinKey(prefix: string, ...parts: string[]): string {
  const base = trimPrefix(prefix)
  const suffix = parts.map(encodeURIComponent).join("/")
  return base ? `${base}/${suffix}` : suffix
}

function scheduleRunKey(prefix: string, id: string): string {
  return joinKey(prefix, "schedule-runs", id)
}

function scheduleRunAttemptKey(prefix: string, id: string): string {
  return joinKey(prefix, "schedule-run-attempts", id)
}

function scheduleRunBase(prefix: string): string {
  return `${joinKey(prefix, "schedule-runs")}/`
}

const keyLocks = new Map<string, Promise<void>>()

async function withKVKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const queued = previous.then(() => current, () => current)
  keyLocks.set(key, queued)

  await previous
  try {
    return await operation()
  }
  finally {
    release()
    if (keyLocks.get(key) === queued) {
      keyLocks.delete(key)
    }
  }
}

function cloneScheduleRun(record: ScheduleRunRecord | StoredScheduleRunRecord): ScheduleRunRecord {
  return {
    ...record,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    createdAt: new Date(record.createdAt),
    error: record.error ? { ...record.error } : undefined,
    response: record.response ? structuredClone(record.response) : undefined,
    scheduledAt: new Date(record.scheduledAt),
    startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
    updatedAt: new Date(record.updatedAt),
  }
}

function cloneScheduleRunAttempt(record: ScheduleRunAttemptRecord | StoredScheduleRunAttemptRecord): ScheduleRunAttemptRecord {
  return {
    ...record,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    createdAt: new Date(record.createdAt),
    error: record.error ? { ...record.error } : undefined,
    startedAt: new Date(record.startedAt),
    updatedAt: new Date(record.updatedAt),
  }
}

function serializeScheduleRun(record: ScheduleRunRecord): StoredScheduleRunRecord {
  return {
    ...record,
    completedAt: record.completedAt?.toISOString(),
    createdAt: record.createdAt.toISOString(),
    error: record.error ? { ...record.error } : undefined,
    response: record.response ? structuredClone(record.response) : undefined,
    scheduledAt: record.scheduledAt.toISOString(),
    startedAt: record.startedAt?.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function serializeScheduleRunAttempt(record: ScheduleRunAttemptRecord): StoredScheduleRunAttemptRecord {
  return {
    ...record,
    completedAt: record.completedAt?.toISOString(),
    createdAt: record.createdAt.toISOString(),
    error: record.error ? { ...record.error } : undefined,
    startedAt: record.startedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

export function createMemoryScheduleRunStore(): ScheduleRunStore {
  const runs = new Map<string, ScheduleRunRecord>()
  const attempts = new Map<string, ScheduleRunAttemptRecord>()

  return {
    createAttempt(attempt) {
      if (attempts.has(attempt.id)) {
        throw scheduleErrorDiagnostics.SCHEDULE_R0030({ message: `Schedule Run Attempt already exists: ${attempt.id}` })
      }
      attempts.set(attempt.id, cloneScheduleRunAttempt(attempt))
      return cloneScheduleRunAttempt(attempt)
    },
    createRun(run) {
      if (runs.has(run.id)) {
        throw scheduleErrorDiagnostics.SCHEDULE_R0031({ message: `Schedule Run already exists: ${run.id}` })
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
    listRuns(options) {
      return selectRuns([...runs.values()], options).map(cloneScheduleRun)
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

function selectRuns(runs: ScheduleRunRecord[], options: ScheduleRunListOptions = {}): ScheduleRunRecord[] {
  const selected = runs.filter(run => (options.scheduleId === undefined || run.scheduleId === options.scheduleId)
    && (options.idPrefix === undefined || run.id.startsWith(options.idPrefix)))
  selected.sort((left, right) => right.scheduledAt.getTime() - left.scheduledAt.getTime())
  return options.limit === undefined ? selected : selected.slice(0, options.limit)
}

function runIndexMetadata(key: string): { id: string, scheduleId: string, scheduledAt: number } | undefined {
  try {
    const parts = keySegments(key, 3)
    const scheduledAt = Date.parse(parts[2]!)
    if (!Number.isFinite(scheduledAt)) return
    return { id: parts[0]!, scheduleId: parts[1]!, scheduledAt }
  }
  catch {
    return undefined
  }
}

function attemptIndexEntry(key: string): { attemptId: string, runId: string } | undefined {
  try {
    const parts = keySegments(key, 2)
    return { attemptId: parts[1]!, runId: parts[0]! }
  }
  catch {
    return undefined
  }
}

function listedKeyId(key: string): string | undefined {
  try {
    return keySegments(key, 1)[0]
  }
  catch {
    return undefined
  }
}

export function createKVScheduleRunStore(options: KVScheduleStoreOptions): ScheduleRunStore {
  const prefix = options.prefix ?? "vitehub:schedule"

  const store = options.kvStore

  async function readSnapshot() {
    const [keys, indexKeys] = await Promise.all([
      store.keys(scheduleRunBase(prefix)),
      store.keys(`${joinKey(prefix, "schedule-run-index")}/`),
    ])
    const metadataById = new Map(indexKeys.flatMap(key => {
      const metadata = runIndexMetadata(key)
      return metadata ? [[metadata.id, metadata] as const] : []
    }))
    type IndexedRun = { id: string, key: string, scheduledAt: number }
    const known: IndexedRun[] = []
    const bySchedule = new Map<string, IndexedRun[]>()
    for (const key of keys) {
      const id = listedKeyId(key)
      const metadata = id === undefined ? undefined : metadataById.get(id)
      if (!metadata) continue
      const entry = { id: metadata.id, key, scheduledAt: metadata.scheduledAt }
      known.push(entry)
      const group = bySchedule.get(metadata.scheduleId) ?? []
      bySchedule.set(metadata.scheduleId, group)
      group.push(entry)
    }
    for (const entries of [known, ...bySchedule.values()]) {
      entries.sort((left, right) => right.scheduledAt - left.scheduledAt)
    }
    return { known, bySchedule, recordsByKey: new Map<string, ScheduleRunRecord | undefined>() }
  }

  async function listRuns(options: ScheduleRunListOptions, snapshot: Awaited<ReturnType<typeof readSnapshot>>) {
    const { recordsByKey } = snapshot
    const known = options.scheduleId === undefined
      ? snapshot.known
      : snapshot.bySchedule.get(options.scheduleId) ?? []
    const matching = options.idPrefix === undefined ? known : known.filter(entry => entry.id.startsWith(options.idPrefix!))
    const records: ScheduleRunRecord[] = []
    const selectedKeys = matching.slice(0, options.limit ?? matching.length).map(entry => entry.key)
    for (let index = 0; index < selectedKeys.length; index += 16) {
      const batch = await Promise.all(selectedKeys.slice(index, index + 16).map(async (key) => {
        if (recordsByKey.has(key)) return recordsByKey.get(key)
        const stored = await store.get<StoredScheduleRunRecord>(key)
        const run = stored ? cloneScheduleRun(stored) : undefined
        recordsByKey.set(key, run)
        return run
      }))
      records.push(...batch.flatMap(run => run ? [run] : []))
    }
    return selectRuns(records, options).map(cloneScheduleRun)
  }

  return {
    async createAttempt(attempt) {
      const key = scheduleRunAttemptKey(prefix, attempt.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw scheduleErrorDiagnostics.SCHEDULE_R0032({ message: `Schedule Run Attempt already exists: ${attempt.id}` })
        }
        await store.set(joinKey(prefix, "schedule-run-attempt-index", attempt.runId, attempt.id), true)
        await store.set(key, serializeScheduleRunAttempt(attempt))
        return cloneScheduleRunAttempt(attempt)
      })
    },
    async createRun(run) {
      const key = scheduleRunKey(prefix, run.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw scheduleErrorDiagnostics.SCHEDULE_R0033({ message: `Schedule Run already exists: ${run.id}` })
        }
        await store.set(joinKey(prefix, "schedule-run-index", run.id, run.scheduleId, run.scheduledAt.toISOString()), true)
        await store.set(key, serializeScheduleRun(run))
        return cloneScheduleRun(run)
      })
    },
    async getAttempt(id) {
      const attempt = await store.get<StoredScheduleRunAttemptRecord>(scheduleRunAttemptKey(prefix, id))
      return attempt ? cloneScheduleRunAttempt(attempt) : undefined
    },
    async getRun(id) {
      const run = await store.get<StoredScheduleRunRecord>(scheduleRunKey(prefix, id))
      return run ? cloneScheduleRun(run) : undefined
    },
    async listAttempts(runId) {
      const indexKeys = await store.keys(`${joinKey(prefix, "schedule-run-attempt-index")}/`)
      const attemptIds = indexKeys.flatMap((key) => {
        const entry = attemptIndexEntry(key)
        return entry?.runId === runId ? [entry.attemptId] : []
      })
      const attempts: ScheduleRunAttemptRecord[] = []
      for (let offset = 0; offset < attemptIds.length; offset += 16) {
        const batch = await Promise.all(attemptIds.slice(offset, offset + 16).map(async (id) => {
          const stored = await store.get<StoredScheduleRunAttemptRecord>(scheduleRunAttemptKey(prefix, id))
          return stored ? cloneScheduleRunAttempt(stored) : undefined
        }))
        attempts.push(...batch.flatMap(attempt => attempt ? [attempt] : []))
      }
      return attempts
    },
    async listRuns(options = {}) {
      return listRuns(options, await readSnapshot())
    },
    async listRunsBatch(options) {
      if (!options.length) return []
      const snapshot = await readSnapshot()
      const results: ScheduleRunRecord[][] = []
      for (const query of options) results.push(await listRuns(query, snapshot))
      return results
    },
    async updateAttempt(id, patch) {
      const key = scheduleRunAttemptKey(prefix, id)
      return await withKVKeyLock(key, async () => {
        const existing = await store.get<StoredScheduleRunAttemptRecord>(key)
        if (!existing) {
          return undefined
        }
        const next = cloneScheduleRunAttempt({
          ...cloneScheduleRunAttempt(existing),
          ...patch,
          updatedAt: patch.updatedAt,
        })
        await store.set(key, serializeScheduleRunAttempt(next))
        return cloneScheduleRunAttempt(next)
      })
    },
    async updateRun(id, patch) {
      const key = scheduleRunKey(prefix, id)
      return await withKVKeyLock(key, async () => {
        const existing = await store.get<StoredScheduleRunRecord>(key)
        if (!existing) {
          return undefined
        }
        const next = cloneScheduleRun({
          ...cloneScheduleRun(existing),
          ...patch,
          updatedAt: patch.updatedAt,
        })
        await store.set(key, serializeScheduleRun(next))
        return cloneScheduleRun(next)
      })
    },
  }
}
