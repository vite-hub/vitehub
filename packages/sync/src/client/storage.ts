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
  /**
   * `true` once a tab sent the write. The server may have applied it, so no later write merges into it, and it keeps its
   * id until the server answers.
   */
  sent?: true
  /**
   * The scope id of a write of Sync v1, which had no account. The write waits, with `account: null`, until a pull has
   * this scope id, and then gets the account of that pull.
   */
  legacyScope?: string
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

/**
 * An update in `add` that merges into the stored update `seq`. The merge happens only when that update is still in the
 * outbox and no tab sent it. Else the storage adds the new update with `patch`, its own patch, and keeps the old one.
 */
interface SyncMerge {
  /** The place of the merged update in `add`. */
  index: number
  seq: number
  patch: SyncRow
}

/** One atomic change of the stored copy of a name. A change does not mix `merge` with `sent` or `remove` of the same write. */
interface SyncStorageChange {
  meta?: SyncMeta
  /** Drops every row before `put`. */
  reset?: boolean
  put?: [SyncKey, SyncRow][]
  delete?: SyncKey[]
  /** Adds writes at the end of the outbox. */
  add?: SyncNewWrite[]
  merge?: SyncMerge[]
  /** Replaces writes with the same `seq`. A write that is gone stays gone. */
  update?: SyncQueuedWrite[]
  /** Marks the writes with these `seq` values as sent, before a tab sends them. */
  sent?: number[]
  /** Removes writes by `seq`. */
  remove?: number[]
}

/** What a change did. */
interface SyncWriteResult {
  /** The `seq` of each added write. */
  seqs: number[]
  /** The `index` of each merge that did not happen. That update is stored with its own patch. */
  unmerged: number[]
  /** The writes of `sent` that were gone, such as after another tab merged them. Do not send them. */
  gone: number[]
}

/** Where a store keeps its rows and its outbox. `id` names one Sync route. */
interface SyncStorage {
  readonly persisted: boolean
  read: (id: string) => Promise<SyncStored>
  /** The meta and the outbox, without the rows. */
  readQueue: (id: string) => Promise<Omit<SyncStored, "rows">>
  /** Applies `change` at once. */
  write: (id: string, change: SyncStorageChange) => Promise<SyncWriteResult>
  clear: () => Promise<void>
}

/** `true` when a new update may merge into `write`: it is a queued update that nobody sent or refused. */
function isMergeable(write: SyncQueuedWrite | undefined): boolean {
  return write?.op === "update" && !write.sent && !write.error
}

/** Applies the row part of `change`. A changed row keeps its place, and a new row goes last. */
function applyRowChange(rows: Map<SyncKey, SyncRow>, change: SyncStorageChange): Map<SyncKey, SyncRow> {
  const next = change.reset ? new Map<SyncKey, SyncRow>() : rows
  for (const key of change.delete ?? []) next.delete(key)
  for (const [key, row] of change.put ?? []) next.set(key, row)
  return next
}

/** The added writes of `change` as stored: an update that did not merge keeps only its own patch. */
function addedWrites(change: SyncStorageChange, result: SyncWriteResult): SyncQueuedWrite[] {
  const unmerged = new Map(change.merge?.filter(merge => result.unmerged.includes(merge.index)).map(merge => [merge.index, merge.patch]))
  return (change.add ?? []).map((write, index): SyncQueuedWrite => {
    const patch = unmerged.get(index)
    return { ...(patch && write.op === "update" ? { ...write, patch } : write), seq: result.seqs[index]! }
  })
}

/** Applies the outbox part of `change`, with what the storage did. */
function applyQueueChange(writes: readonly SyncQueuedWrite[], change: SyncStorageChange, result: SyncWriteResult): SyncQueuedWrite[] {
  const removed = new Set(change.remove)
  for (const merge of change.merge ?? []) {
    if (!result.unmerged.includes(merge.index)) removed.add(merge.seq)
  }
  const updated = new Map(change.update?.map(write => [write.seq, write]))
  const sent = new Set(change.sent)
  return [
    ...writes.filter(write => !removed.has(write.seq)).map((write) => {
      const next = updated.get(write.seq) ?? write
      return sent.has(write.seq) && !next.sent ? { ...next, sent: true as const } : next
    }),
    ...addedWrites(change, result),
  ]
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
      const bySeq = new Map(current.writes.map(write => [write.seq, write]))
      const result: SyncWriteResult = {
        seqs: (copy.add ?? []).map(() => ++seq),
        unmerged: (copy.merge ?? []).filter(merge => !isMergeable(bySeq.get(merge.seq))).map(merge => merge.index),
        gone: (copy.sent ?? []).filter(sent => !bySeq.has(sent)),
      }
      names.set(id, {
        meta: copy.meta ?? current.meta,
        rows: applyRowChange(current.rows, copy),
        writes: applyQueueChange(current.writes, copy, result),
      })
      return result
    },
    async clear() {
      names.clear()
    },
  }
}

export { addedWrites, applyQueueChange, applyRowChange, createMemoryStorage, isMergeable }
export type { SyncMerge, SyncMeta, SyncNewWrite, SyncQueuedWrite, SyncStorage, SyncStorageChange, SyncStored, SyncWriteResult }
