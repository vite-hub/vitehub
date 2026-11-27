import type { SyncKey, SyncRow, SyncScope, SyncWireError } from "../protocol.ts"

/** What a store knows about the server copy, from the last pull. */
interface SyncMeta {
  scope: SyncScope
  /** The primary key column. */
  key: string
  cursor: number
  /** The account that the writes of the client belong to. */
  account: string
  /** The fingerprint of the table that the stored rows have. */
  version: string
  /** The static column defaults, for optimistic inserts. */
  defaults: SyncRow
  /** The `after` of the last page of a snapshot that is not done yet. */
  after?: SyncKey
}

/**
 * A write in the outbox. `seq` is its place in the queue. `account` is the account of the pull when it was made, or
 * `null` before the first pull. Writes of another account wait in the outbox until that account comes back. An insert
 * keeps the caller's value: the key and the scope values go in when it is sent. An action keeps its name and arguments,
 * and `key` is its mutation id.
 */
type SyncQueuedWrite = {
  seq: number
  /** The mutation id. */
  id: string
  account: string | null
  key: SyncKey
  /** Set when the server refused the write. It then stays out of `rows` and is not sent. */
  error?: SyncWireError
} & ({ op: "insert", value: SyncRow } | { op: "update", patch: SyncRow } | { op: "delete" } | { op: "action", name: string, args: unknown })

/** A write before the storage gave it a `seq`. */
type SyncNewWrite = SyncQueuedWrite extends infer TWrite ? TWrite extends unknown ? Omit<TWrite, "seq"> : never : never

interface SyncStored {
  meta: SyncMeta | undefined
  /** The confirmed rows, in order. */
  rows: [SyncKey, SyncRow][]
  /** The outbox, in order. */
  writes: SyncQueuedWrite[]
}

/** One atomic change of the stored copy of a name. */
interface SyncStorageChange {
  epoch?: number
  meta?: SyncMeta
  /** Drops every row before `put`. */
  reset?: boolean
  put?: [SyncKey, SyncRow][]
  delete?: SyncKey[]
  /** Adds writes at the end of the outbox. */
  add?: SyncNewWrite[]
  /** Replaces writes with the same `seq`. A write that is gone stays gone. */
  update?: SyncQueuedWrite[]
  claim?: { from: string, to: string, seqs: number[] }
  /** Removes writes by `seq`. */
  remove?: number[]
  /** Results of actions that the server applied, by mutation id, for the tab that made the call. */
  results?: [string, unknown][]
}

/** What a change did. */
interface SyncWriteResult {
  /** The `seq` of each added write. */
  seqs: number[]
  claimed?: number[]
}

/** Where a store keeps its rows and its outbox. `id` names one Sync route. */
interface SyncStorage {
  readonly persisted: boolean
  readonly epoch: number
  read: (id: string) => Promise<SyncStored>
  /** The meta and the outbox, without the rows. */
  readQueue: (id: string) => Promise<Omit<SyncStored, "rows">>
  /** Applies `change` at once. */
  write: (id: string, change: SyncStorageChange) => Promise<SyncWriteResult>
  /** Reads and deletes the stored results of these actions. An action without a result is not in the map. */
  takeResults: (ids: readonly string[]) => Promise<Map<string, unknown>>
  /** The ids that have writes in the outbox. */
  queuedIds: () => Promise<string[]>
  /**
   * Forgets every row, meta and action result, and the outbox. With `keepWrites`, the writes of an account stay in the
   * outbox for it. A write made before the first pull has no account, and goes.
   */
  clear: (options?: { keepWrites?: boolean }) => Promise<void>
}

const storageLost = new Error("The stored Sync copy was lost.")

/** How long the storage keeps the result of an action that no tab read, in milliseconds. */
const resultLifetime = 10 * 60_000

/** Applies the row part of `change`. A changed row keeps its place, and a new row goes last. */
function applyRowChange(rows: Map<SyncKey, SyncRow>, change: SyncStorageChange): Map<SyncKey, SyncRow> {
  const next = change.reset ? new Map<SyncKey, SyncRow>() : rows
  for (const key of change.delete ?? []) next.delete(key)
  for (const [key, row] of change.put ?? []) next.set(key, row)
  return next
}

/** The added writes of `change` as stored, with their `seq`. */
function addedWrites(change: SyncStorageChange, result: SyncWriteResult): SyncQueuedWrite[] {
  return (change.add ?? []).map((write, index): SyncQueuedWrite => ({ ...write, seq: result.seqs[index]! }))
}

/** Applies the outbox part of `change`, with what the storage did. */
function applyQueueChange(writes: readonly SyncQueuedWrite[], change: SyncStorageChange, result: SyncWriteResult): SyncQueuedWrite[] {
  const removed = new Set(change.remove)
  const updated = new Map(change.update?.map(write => [write.seq, write]))
  const claimed = new Set(result.claimed)
  return [
    ...writes.filter(write => !removed.has(write.seq)).map(write => {
      if (change.claim && claimed.has(write.seq)) return { ...write, account: change.claim.to }
      return updated.get(write.seq) ?? write
    }),
    ...addedWrites(change, result),
  ]
}

/** A storage in memory. Values are copied in and out, as IndexedDB does. */
function createMemoryStorage(): SyncStorage {
  const names = new Map<string, { meta: SyncMeta | undefined, rows: Map<SyncKey, SyncRow>, writes: SyncQueuedWrite[] }>()
  const results = new Map<string, { result: unknown, at: number }>()
  let seq = 0
  const entry = (id: string) => names.get(id) ?? { meta: undefined, rows: new Map<SyncKey, SyncRow>(), writes: [] }
  return {
    persisted: false,
    epoch: 0,
    async read(id) {
      const { meta, rows, writes } = entry(id)
      return structuredClone({ meta, rows: [...rows], writes })
    },
    async readQueue(id) {
      const { meta, writes } = entry(id)
      return structuredClone({ meta, writes })
    },
    async write(id, change) {
      const copy = structuredClone(change)
      const current = entry(id)
      const result: SyncWriteResult = { seqs: (copy.add ?? []).map(() => ++seq) }
      if (copy.claim) {
        const { from, seqs } = copy.claim
        result.claimed = current.writes.filter(write => write.account === from && seqs.includes(write.seq)).map(write => write.seq)
      }
      names.set(id, {
        meta: copy.meta ?? current.meta,
        rows: applyRowChange(current.rows, copy),
        writes: applyQueueChange(current.writes, copy, result),
      })
      const now = Date.now()
      for (const [mutationId, stored] of results) {
        if (stored.at < now - resultLifetime) results.delete(mutationId)
      }
      for (const [mutationId, value] of copy.results ?? []) results.set(mutationId, { result: value, at: now })
      return result
    },
    async takeResults(ids) {
      const found = new Map<string, unknown>()
      for (const mutationId of ids) {
        const stored = results.get(mutationId)
        if (!stored) continue
        found.set(mutationId, structuredClone(stored.result))
        results.delete(mutationId)
      }
      return found
    },
    async queuedIds() {
      return [...names].filter(([, stored]) => stored.writes.length).map(([id]) => id)
    },
    async clear(options) {
      results.clear()
      if (!options?.keepWrites) return names.clear()
      for (const [id, stored] of names) {
        const writes = stored.writes.filter(write => write.account !== null)
        if (writes.length) names.set(id, { meta: undefined, rows: new Map(), writes })
        else names.delete(id)
      }
    },
  }
}

export { addedWrites, applyQueueChange, applyRowChange, createMemoryStorage, resultLifetime, storageLost }
export type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange, SyncStored, SyncWriteResult }
