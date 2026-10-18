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

// Index publication is best effort for stores that do not support the derived
// metadata keys. Keep fallback inspection bounded when retained history has no
// usable index, while indexed records continue to support complete queries.
const maxLegacyHistoryRecords = 1000

/** Raised when the metadata index cannot provide a complete history safely. */
export class ScheduleHistoryIncompleteError extends Error {
  readonly code = "SCHEDULE_HISTORY_INCOMPLETE"

  constructor(readonly recordCount: number, readonly maxRecords: number) {
    super(`Schedule run history is incomplete because ${recordCount} records have no usable metadata index (maximum fallback is ${maxRecords}). Rebuild the schedule run index before listing history.`)
    this.name = "ScheduleHistoryIncompleteError"
  }
}

function trimPrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "")
}

/**
 * Decoded trailing segments of a listed key. Some KV stores, such as unstorage, list keys with `:` instead of `/`.
 * Encoded parts contain neither, so both separators are safe to split on.
 */
function keySegments(key: string, count: number): string[] {
  return key.split(/[/:]/).slice(-count).map(decodeURIComponent)
}

function joinKey(prefix: string, ...parts: string[]): string {
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
  return joinKey(prefix, "schedule-runs")
}

function scheduleRunAttemptBase(prefix: string): string {
  return joinKey(prefix, "schedule-run-attempts")
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

function cloneScheduleRun(record: ScheduleRunRecord): ScheduleRunRecord {
  return {
    ...record,
    completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
    createdAt: new Date(record.createdAt),
    scheduledAt: new Date(record.scheduledAt),
    error: record.error ? { ...record.error } : undefined,
    response: record.response ? structuredClone(record.response) : undefined,
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

function deserializeScheduleRun(record: StoredScheduleRunRecord): ScheduleRunRecord {
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

function deserializeScheduleRunAttempt(record: StoredScheduleRunAttemptRecord): ScheduleRunAttemptRecord {
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
  const selected = runs.filter(run => options.scheduleId === undefined || run.scheduleId === options.scheduleId)
  selected.sort((left, right) => right.scheduledAt.getTime() - left.scheduledAt.getTime())
  return options.limit === undefined ? selected : selected.slice(0, options.limit)
}

/** Index keys carry metadata from the stored record, independent of caller-selected run IDs. */
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

export function createKVScheduleRunStore(options: KVScheduleStoreOptions): ScheduleRunStore {
  const prefix = options.prefix ?? "vitehub:schedule"

  const store = options.kvStore
  async function indexRun(run: ScheduleRunRecord): Promise<void> {
    try {
      await store.set(joinKey(prefix, "schedule-run-index", run.id, run.scheduleId, run.scheduledAt.toISOString()), true)
    }
    catch {
      // The run remains authoritative when its derived metadata index is unavailable.
    }
  }

  async function indexAttempt(attempt: ScheduleRunAttemptRecord): Promise<void> {
    try {
      await store.set(joinKey(prefix, "schedule-run-attempt-index", attempt.runId, attempt.id), true)
    }
    catch {
      // Attempt records remain authoritative if their derived index is unavailable.
    }
  }

  async function readSnapshot() {
    const keys = await store.keys(scheduleRunBase(prefix))
    const indexKeys = await store.keys(joinKey(prefix, "schedule-run-index"))
    const metadataById = new Map(indexKeys.flatMap(key => {
      const metadata = runIndexMetadata(key)
      return metadata ? [[metadata.id, metadata] as const] : []
    }))
    type IndexedRun = { key: string, scheduledAt: number }
    const known: IndexedRun[] = []
    const bySchedule = new Map<string, IndexedRun[]>()
    const unknown: string[] = []
    const recordsByKey = new Map<string, ScheduleRunRecord | undefined>()
    function groupRun(key: string, metadata: { id: string, scheduleId: string, scheduledAt: number }) {
      const entry = { key, scheduledAt: metadata.scheduledAt }
      known.push(entry)
      const group = bySchedule.get(metadata.scheduleId) ?? []
      bySchedule.set(metadata.scheduleId, group)
      group.push(entry)
    }
    for (const key of keys) {
      let id: string
      try {
        id = keySegments(key, 1)[0]!
      }
      catch {
        unknown.push(key)
        continue
      }
      const metadata = metadataById.get(id)
      if (!metadata) {
        unknown.push(key)
        continue
      }
      groupRun(key, metadata)
    }
    // Refuse an over-cap legacy namespace before reading an arbitrary provider-
    // ordered prefix. Callers receive an explicit incomplete-history result,
    // so no partial set can be mistaken for the newest or complete history.
    if (unknown.length > maxLegacyHistoryRecords) {
      return { keys, known, bySchedule, recordsByKey, unknown }
    }
    // Group legacy records once per snapshot, even when their index cannot be published.
    // The over-cap case returned above, so every remaining legacy key is read.
    // This keeps the fallback complete without depending on provider key order.
    const legacyKeys = unknown
    for (let offset = 0; offset < legacyKeys.length; offset += 16) {
      const batch = await Promise.all(legacyKeys.slice(offset, offset + 16).map(async key => {
        const stored = await store.get<StoredScheduleRunRecord>(key)
        const run = stored ? deserializeScheduleRun(stored) : undefined
        recordsByKey.set(key, run)
        if (run) await indexRun(run)
        return { key, run }
      }))
      for (const { key, run } of batch) {
        if (run) groupRun(key, { id: run.id, scheduleId: run.scheduleId, scheduledAt: run.scheduledAt.getTime() })
      }
    }
    for (const entries of [known, ...bySchedule.values()]) {
      entries.sort((left, right) => right.scheduledAt - left.scheduledAt)
    }
    return { keys, known, bySchedule, recordsByKey, unknown }
  }

  async function listRuns(options: ScheduleRunListOptions, snapshot: Awaited<ReturnType<typeof readSnapshot>>) {
    if (snapshot.unknown.length > maxLegacyHistoryRecords) {
      // KV key order is not an ordering contract. Once the bounded fallback is
      // exceeded, any filtered or limit-only result could silently omit a
      // matching record, so fail explicitly instead of returning partial data.
      throw new ScheduleHistoryIncompleteError(snapshot.unknown.length, maxLegacyHistoryRecords)
    }
    const { keys, recordsByKey } = snapshot
    const known = options.scheduleId === undefined
      ? snapshot.known
      : snapshot.bySchedule.get(options.scheduleId) ?? []
    // Read selected indexed records with bounded concurrency; legacy records are already cached.
    const records: ScheduleRunRecord[] = []
    const selectedKeys = options.scheduleId === undefined && options.limit === undefined
      ? keys
      : known.slice(0, options.limit ?? known.length).map(entry => entry.key)
    for (let index = 0; index < selectedKeys.length; index += 16) {
      const batch = await Promise.all(selectedKeys.slice(index, index + 16).map(async (key) => {
        if (recordsByKey.has(key)) return recordsByKey.get(key)
        const stored = await store.get<StoredScheduleRunRecord>(key)
        const run = stored ? deserializeScheduleRun(stored) : undefined
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
        await store.set(key, serializeScheduleRunAttempt(attempt))
        await indexAttempt(attempt)
        return cloneScheduleRunAttempt(attempt)
      })
    },
    async createRun(run) {
      const key = scheduleRunKey(prefix, run.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw scheduleErrorDiagnostics.SCHEDULE_R0033({ message: `Schedule Run already exists: ${run.id}` })
        }
        await store.set(key, serializeScheduleRun(run))
        await indexRun(run)
        return cloneScheduleRun(run)
      })
    },
    async getAttempt(id) {
      const attempt = await store.get<StoredScheduleRunAttemptRecord>(scheduleRunAttemptKey(prefix, id))
      return attempt ? deserializeScheduleRunAttempt(attempt) : undefined
    },
    async getRun(id) {
      const run = await store.get<StoredScheduleRunRecord>(scheduleRunKey(prefix, id))
      return run ? deserializeScheduleRun(run) : undefined
    },
    async listAttempts(runId) {
      const [keys, indexKeys] = await Promise.all([
        store.keys(`${scheduleRunAttemptBase(prefix)}/`),
        store.keys(`${joinKey(prefix, "schedule-run-attempt-index")}/`),
      ])
      const runByAttemptId = new Map<string, string>()
      for (const key of indexKeys) {
        try {
          const parts = keySegments(key, 2)
          runByAttemptId.set(parts[1]!, parts[0]!)
        }
        catch {}
      }
      const selectedKeys = keys.filter((key) => {
        try {
          const id = keySegments(key, 1)[0]!
          const indexedRunId = runByAttemptId.get(id)
          return indexedRunId === undefined || indexedRunId === runId
        }
        catch {
          return true
        }
      })
      const attempts: ScheduleRunAttemptRecord[] = []
      // Backfill legacy or missing indexes with bounded reads, without hiding retained attempts.
      for (let offset = 0; offset < selectedKeys.length; offset += 16) {
        const batch = await Promise.all(selectedKeys.slice(offset, offset + 16).map(async (key) => {
          const stored = await store.get<StoredScheduleRunAttemptRecord>(key)
          if (!stored) return
          const attempt = deserializeScheduleRunAttempt(stored)
          if (!runByAttemptId.has(attempt.id)) await indexAttempt(attempt)
          return attempt.runId === runId ? attempt : undefined
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
          ...deserializeScheduleRunAttempt(existing),
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
          ...deserializeScheduleRun(existing),
          ...patch,
          updatedAt: patch.updatedAt,
        })
        await store.set(key, serializeScheduleRun(next))
        return cloneScheduleRun(next)
      })
    },
  }
}
