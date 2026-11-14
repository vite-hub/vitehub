import type { SyncKey, SyncRow, SyncScope, SyncWireError } from "../protocol.ts"

/** What a store knows about the server copy, from the last pull. */
interface SyncMeta {
  scope: SyncScope
  /** The primary key column. */
  key: string
  cursor: number
}

/**
 * A write in the outbox. `seq` is its place in the queue. `scope` is the scope id when it was made, or `null` before
 * the first pull. An insert keeps the caller's value: the key and the scope values go in when it is sent.
 */
type SyncQueuedWrite = {
  seq: number
  /** The mutation id. */
  id: string
  scope: string | null
  key: SyncKey
  /** Set when the server refused the write. It then stays out of `rows` and is not sent. */
  error?: SyncWireError
} & ({ op: "insert", value: SyncRow } | { op: "update", patch: SyncRow } | { op: "delete" })

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
  meta?: SyncMeta
  /** Drops every row before `put`. */
  reset?: boolean
  put?: [SyncKey, SyncRow][]
  delete?: SyncKey[]
  /** Adds writes at the end of the outbox. */
  add?: SyncNewWrite[]
  /** Replaces writes with the same `seq`. */
  update?: SyncQueuedWrite[]
  /** Removes writes by `seq`. */
  remove?: number[]
}

/** Where a store keeps its rows and its outbox. `id` names one Sync route. */
interface SyncStorage {
  readonly persisted: boolean
  read: (id: string) => Promise<SyncStored>
  /** The meta and the outbox, without the rows. */
  readQueue: (id: string) => Promise<Omit<SyncStored, "rows">>
  /** Applies `change` at once, and returns the `seq` of each added write. */
  write: (id: string, change: SyncStorageChange) => Promise<number[]>
  clear: () => Promise<void>
}

/** Applies the row part of `change`. A changed row keeps its place, and a new row goes last. */
function applyRowChange(rows: Map<SyncKey, SyncRow>, change: SyncStorageChange): Map<SyncKey, SyncRow> {
  const next = change.reset ? new Map<SyncKey, SyncRow>() : rows
  for (const key of change.delete ?? []) next.delete(key)
  for (const [key, row] of change.put ?? []) next.set(key, row)
  return next
}

/** Applies the outbox part of `change`. `seqs` are the `seq` values of the added writes. */
function applyQueueChange(writes: readonly SyncQueuedWrite[], change: SyncStorageChange, seqs: readonly number[]): SyncQueuedWrite[] {
  const removed = new Set(change.remove)
  const updated = new Map(change.update?.map(write => [write.seq, write]))
  const added = (change.add ?? []).map((write, index): SyncQueuedWrite => ({ ...write, seq: seqs[index]! }))
  return [...writes.filter(write => !removed.has(write.seq)).map(write => updated.get(write.seq) ?? write), ...added]
}

/** A storage in memory. Values are copied in and out, as IndexedDB does. */
function createMemoryStorage(): SyncStorage {
  const names = new Map<string, { meta: SyncMeta | undefined, rows: Map<SyncKey, SyncRow>, writes: SyncQueuedWrite[] }>()
  let seq = 0
  const entry = (id: string) => names.get(id) ?? { meta: undefined, rows: new Map<SyncKey, SyncRow>(), writes: [] }
  return {
    persisted: false,
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
      const seqs = (copy.add ?? []).map(() => ++seq)
      names.set(id, {
        meta: copy.meta ?? current.meta,
        rows: applyRowChange(current.rows, copy),
        writes: applyQueueChange(current.writes, copy, seqs),
      })
      return seqs
    },
    async clear() {
      names.clear()
    },
  }
}

export { applyQueueChange, applyRowChange, createMemoryStorage }
export type { SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange, SyncStored }
