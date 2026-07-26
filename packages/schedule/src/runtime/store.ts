import { assertRuntimeScheduleId, createScheduleError } from "../errors.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleUpdateInput, ScheduleRunAttemptRecord, ScheduleRunRecord, ScheduleRunStore } from "../types.ts"

const KV_PACKAGE_NAME = "@vite-hub/kv"

export interface ScheduleKVStorage {
  del(key: string): boolean | Promise<boolean> | Promise<void> | void
  get<T = unknown>(key: string): Promise<T | null | undefined> | T | null | undefined
  has(key: string): boolean | Promise<boolean>
  keys(base?: string): Promise<string[]> | string[]
  set<T = unknown>(key: string, value: T): Promise<void> | void
}

export interface KVScheduleStoreOptions {
  kvStore?: ScheduleKVStorage
  prefix?: string
}

type StoredRuntimeScheduleRecord = Omit<RuntimeScheduleRecord, "createdAt" | "updatedAt"> & {
  createdAt: string
  updatedAt: string
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

function joinKey(prefix: string, ...parts: string[]): string {
  const base = trimPrefix(prefix)
  const suffix = parts.map(encodeURIComponent).join("/")
  return base ? `${base}/${suffix}` : suffix
}

function runtimeScheduleKey(prefix: string, id: string): string {
  return joinKey(prefix, "runtime-schedules", id)
}

function scheduleRunKey(prefix: string, id: string): string {
  return joinKey(prefix, "schedule-runs", id)
}

function scheduleRunAttemptKey(prefix: string, id: string): string {
  return joinKey(prefix, "schedule-run-attempts", id)
}

function runtimeScheduleBase(prefix: string): string {
  return joinKey(prefix, "runtime-schedules")
}

function scheduleRunBase(prefix: string): string {
  return joinKey(prefix, "schedule-runs")
}

function scheduleRunAttemptBase(prefix: string): string {
  return joinKey(prefix, "schedule-run-attempts")
}

function isMissingKVPackage(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes(`Cannot find package '${KV_PACKAGE_NAME}'`)
}

async function resolveDefaultKVStore(): Promise<ScheduleKVStorage> {
  let module
  try {
    module = await import(KV_PACKAGE_NAME) as typeof import("@vite-hub/kv")
  }
  catch (error) {
    if (isMissingKVPackage(error)) {
      throw new Error("[vitehub:schedule] The default KV-backed stores require @vite-hub/kv. Install it with: pnpm add @vite-hub/kv", { cause: error })
    }
    throw error
  }

  return {
    async del(key) {
      const [error] = await module.kv.del(key)
      if (error) throw error
    },
    async get<T = unknown>(key: string) {
      const [error, value] = await module.kv.get<T>(key)
      if (error) throw error
      return value
    },
    async has(key) {
      const [error, value] = await module.kv.has(key)
      if (error) throw error
      return value
    },
    async keys(base) {
      const [error, value] = await module.kv.keys(base)
      if (error) throw error
      return value
    },
    async set(key, value) {
      const [error] = await module.kv.set(key, value)
      if (error) throw error
    },
  }
}

function cloneRuntimeSchedule<TInput>(record: RuntimeScheduleRecord<TInput>): RuntimeScheduleRecord<TInput> {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    ...(record.input !== undefined ? { input: structuredClone(record.input) } : {}),
    updatedAt: new Date(record.updatedAt),
  }
}

function serializeRuntimeSchedule(record: RuntimeScheduleRecord): StoredRuntimeScheduleRecord {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    ...(record.input !== undefined ? { input: structuredClone(record.input) } : {}),
    updatedAt: record.updatedAt.toISOString(),
  }
}

function deserializeRuntimeSchedule(record: StoredRuntimeScheduleRecord): RuntimeScheduleRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    ...(record.input !== undefined ? { input: structuredClone(record.input) } : {}),
    updatedAt: new Date(record.updatedAt),
  }
}

function omitUndefinedPatch(patch: RuntimeScheduleUpdateInput): RuntimeScheduleUpdateInput {
  return {
    ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(Object.hasOwn(patch, "input") ? { input: structuredClone(patch.input) } : {}),
    ...(patch.target !== undefined ? { target: patch.target } : {}),
    ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
  }
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

export function createMemoryRuntimeScheduleStore(): RuntimeScheduleStore {
  const records = new Map<string, RuntimeScheduleRecord>()

  return {
    create(record) {
      assertRuntimeScheduleId(record.id)
      if (records.has(record.id)) {
        throw createScheduleError("SCHEDULE_ALREADY_EXISTS")
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

export function createKVRuntimeScheduleStore(options: KVScheduleStoreOptions = {}): RuntimeScheduleStore {
  const prefix = options.prefix ?? "vitehub:schedule"

  async function getKVStore() {
    return options.kvStore || await resolveDefaultKVStore()
  }

  return {
    async create(record) {
      assertRuntimeScheduleId(record.id)
      const store = await getKVStore()
      const key = runtimeScheduleKey(prefix, record.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw createScheduleError("SCHEDULE_ALREADY_EXISTS")
        }
        await store.set(key, serializeRuntimeSchedule(record))
        return cloneRuntimeSchedule(record)
      })
    },
    async delete(id) {
      const store = await getKVStore()
      const key = runtimeScheduleKey(prefix, id)
      return await withKVKeyLock(key, async () => {
        const exists = await store.has(key)
        if (!exists) {
          return false
        }
        await store.del(key)
        return true
      })
    },
    async get(id) {
      const record = await (await getKVStore()).get<StoredRuntimeScheduleRecord>(runtimeScheduleKey(prefix, id))
      return record ? deserializeRuntimeSchedule(record) : undefined
    },
    async list() {
      const store = await getKVStore()
      const keys = await store.keys(runtimeScheduleBase(prefix))
      const records = await Promise.all(keys.map(key => store.get<StoredRuntimeScheduleRecord>(key)))
      return records.flatMap(record => record ? [deserializeRuntimeSchedule(record)] : [])
    },
    async update(id, patch) {
      const store = await getKVStore()
      const key = runtimeScheduleKey(prefix, id)
      return await withKVKeyLock(key, async () => {
        const existing = await store.get<StoredRuntimeScheduleRecord>(key)
        if (!existing) {
          return undefined
        }
        const next = cloneRuntimeSchedule({
          ...deserializeRuntimeSchedule(existing),
          ...omitUndefinedPatch(patch),
          updatedAt: patch.updatedAt,
        })
        await store.set(key, serializeRuntimeSchedule(next))
        return cloneRuntimeSchedule(next)
      })
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

function serializeScheduleRun(record: ScheduleRunRecord): StoredScheduleRunRecord {
  return {
    ...record,
    completedAt: record.completedAt?.toISOString(),
    createdAt: record.createdAt.toISOString(),
    error: record.error ? { ...record.error } : undefined,
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

export function createKVScheduleRunStore(options: KVScheduleStoreOptions = {}): ScheduleRunStore {
  const prefix = options.prefix ?? "vitehub:schedule"

  async function getKVStore() {
    return options.kvStore || await resolveDefaultKVStore()
  }

  return {
    async createAttempt(attempt) {
      const store = await getKVStore()
      const key = scheduleRunAttemptKey(prefix, attempt.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw new Error(`Schedule Run Attempt already exists: ${attempt.id}`)
        }
        await store.set(key, serializeScheduleRunAttempt(attempt))
        return cloneScheduleRunAttempt(attempt)
      })
    },
    async createRun(run) {
      const store = await getKVStore()
      const key = scheduleRunKey(prefix, run.id)
      return await withKVKeyLock(key, async () => {
        if (await store.has(key)) {
          throw new Error(`Schedule Run already exists: ${run.id}`)
        }
        await store.set(key, serializeScheduleRun(run))
        return cloneScheduleRun(run)
      })
    },
    async getAttempt(id) {
      const attempt = await (await getKVStore()).get<StoredScheduleRunAttemptRecord>(scheduleRunAttemptKey(prefix, id))
      return attempt ? deserializeScheduleRunAttempt(attempt) : undefined
    },
    async getRun(id) {
      const run = await (await getKVStore()).get<StoredScheduleRunRecord>(scheduleRunKey(prefix, id))
      return run ? deserializeScheduleRun(run) : undefined
    },
    async listAttempts(runId) {
      const store = await getKVStore()
      const keys = await store.keys(scheduleRunAttemptBase(prefix))
      const attempts = await Promise.all(keys.map(key => store.get<StoredScheduleRunAttemptRecord>(key)))
      return attempts.flatMap(attempt => attempt && attempt.runId === runId ? [deserializeScheduleRunAttempt(attempt)] : [])
    },
    async listRuns() {
      const store = await getKVStore()
      const keys = await store.keys(scheduleRunBase(prefix))
      const runs = await Promise.all(keys.map(key => store.get<StoredScheduleRunRecord>(key)))
      return runs.flatMap(run => run ? [deserializeScheduleRun(run)] : [])
    },
    async updateAttempt(id, patch) {
      const store = await getKVStore()
      const key = scheduleRunAttemptKey(prefix, id)
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
    },
    async updateRun(id, patch) {
      const store = await getKVStore()
      const key = scheduleRunKey(prefix, id)
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
    },
  }
}
