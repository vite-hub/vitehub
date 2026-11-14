// A small IndexedDB storage for Sync, with no dependency. One database holds every Sync store of the origin: `rows` by
// [store, key], `meta` by store, and `outbox` in insertion order, with the store in `store`. Each change is one
// transaction. A store is a route plus a subset, such as `/api/_vitehub/sync/comments?{"issueId":"i1"}`.
import { isMergeable } from "./storage.ts"

import type { SyncKey, SyncRow } from "../protocol.ts"
import type { SyncMeta, SyncQueuedWrite, SyncStorage, SyncStored, SyncWriteResult } from "./storage.ts"

const databaseName = "vitehub-sync"
// Format 2 (Sync v2) adds the account, the table version and the defaults to the meta, and tags each write with its
// account instead of its scope. Format 3 keeps the store of a write in `store`, since `name` is the name of an action.
// Format 4 marks sent writes and keeps the v1 scope of a write in `legacyScope`. An upgrade drops the stored rows and
// keeps the outbox.
const format = 4

interface MetaRecord extends SyncMeta {
  name: string
  format: number
  /** The place of the next new row. */
  next: number
}

interface RowRecord {
  name: string
  key: SyncKey
  order: number
  row: SyncRow
}

type OutboxRecord = SyncQueuedWrite & { store: string }

function rowsOf(name: string): IDBKeyRange {
  // An array key sorts after every string, so this range holds every key of `name`.
  return IDBKeyRange.bound([name], [name, []])
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error("The IndexedDB transaction was aborted."))
    transaction.onerror = () => reject(transaction.error ?? new Error("The IndexedDB transaction failed."))
  })
}

/**
 * Moves an outbox of an older format to the current one. Before format 3, `name` held the store. A write of format 1
 * has the scope id that it was made for, and no account: it keeps the scope id in `legacyScope` and waits for a pull
 * with that scope id. Any write may have been sent before the upgrade, so each one is marked as sent.
 */
function upgradeOutbox(outbox: IDBObjectStore, oldVersion: number): void {
  if (oldVersion < 3) {
    if (outbox.indexNames.contains("name")) outbox.deleteIndex("name")
    outbox.createIndex("store", "store")
  }
  const cursor = outbox.openCursor()
  cursor.onsuccess = () => {
    const current = cursor.result
    if (!current) return
    // SAFETY: the outbox holds records of an older format, which `current.value` reads as plain fields.
    const record = current.value as Record<string, unknown>
    if (oldVersion >= 3) {
      current.update({ ...record, sent: true })
    }
    else {
      const { name, scope, ...write } = record
      const legacy = oldVersion === 1 && typeof scope === "string" ? { account: null, legacyScope: scope } : {}
      current.update({ ...write, ...(oldVersion === 1 ? { account: null } : {}), ...legacy, store: name, sent: true })
    }
    current.continue()
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, format)
    request.onupgradeneeded = (event) => {
      const database = request.result
      if (event.oldVersion === 0) {
        database.createObjectStore("rows", { keyPath: ["name", "key"] })
        database.createObjectStore("meta", { keyPath: "name" })
        database.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("store", "store")
        return
      }
      const transaction = request.transaction!
      transaction.objectStore("rows").clear()
      transaction.objectStore("meta").clear()
      upgradeOutbox(transaction.objectStore("outbox"), event.oldVersion)
    }
    request.onsuccess = () => {
      const database = request.result
      // A newer format in another tab must not wait for this tab to close.
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open."))
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."))
  })
}

function readMeta(record: MetaRecord | undefined): SyncMeta | undefined {
  if (!record || record.format !== format) return undefined
  return { scope: record.scope, key: record.key, cursor: record.cursor, account: record.account, version: record.version, defaults: record.defaults }
}

function readWrites(records: OutboxRecord[]): SyncQueuedWrite[] {
  return records.map(({ store: _store, ...write }) => write as SyncQueuedWrite)
}

/**
 * Sync storage in IndexedDB. When the database does not open, such as in some private windows, it uses `fallback`
 * and `persisted` becomes `false`.
 */
function createIndexedDBStorage(fallback: () => SyncStorage): SyncStorage {
  let persisted = true
  let opening: Promise<IDBDatabase | SyncStorage> | undefined

  function open(): Promise<IDBDatabase | SyncStorage> {
    opening ??= openDatabase().catch(() => {
      persisted = false
      return fallback()
    })
    return opening
  }

  async function read(id: string, withRows: boolean): Promise<SyncStored> {
    const database = await open()
    if (!(database instanceof IDBDatabase)) return withRows ? database.read(id) : { ...await database.readQueue(id), rows: [] }
    const transaction = database.transaction(["rows", "meta", "outbox"], "readonly")
    const meta = transaction.objectStore("meta").get(id)
    const rows = withRows ? transaction.objectStore("rows").getAll(rowsOf(id)) : undefined
    const outbox = transaction.objectStore("outbox").index("store").getAll(id)
    await done(transaction)
    const stored = readMeta(meta.result as MetaRecord | undefined)
    const records = stored ? (rows?.result ?? []) as RowRecord[] : []
    return {
      meta: stored,
      rows: records.sort((a, b) => a.order - b.order).map(record => [record.key, record.row]),
      writes: readWrites(outbox.result as OutboxRecord[]),
    }
  }

  return {
    get persisted() {
      return persisted
    },
    read: id => read(id, true),
    async readQueue(id) {
      const { meta, writes } = await read(id, false)
      return { meta, writes }
    },
    async write(id, change) {
      const database = await open()
      if (!(database instanceof IDBDatabase)) return database.write(id, change)
      const transaction = database.transaction(["rows", "meta", "outbox"], "readwrite")
      const rows = transaction.objectStore("rows")
      const metaStore = transaction.objectStore("meta")
      const outbox = transaction.objectStore("outbox")
      const result: SyncWriteResult = { seqs: [], unmerged: [], gone: [] }
      const current = metaStore.get(id)
      current.onsuccess = () => {
        const record = current.result as MetaRecord | undefined
        const known = record?.format === format ? record : undefined
        let next = change.reset || !known ? 0 : known.next
        if (change.reset || !known) rows.delete(rowsOf(id))
        for (const key of change.delete ?? []) rows.delete([id, key])
        const puts = change.put ?? []
        // Requests in one transaction run in order, so the last read finishes after every other read.
        const existing = puts.map(([key]) => rows.get([id, key]))
        const finish = () => {
          puts.forEach(([key, row], index) => {
            const order = (existing[index]!.result as RowRecord | undefined)?.order ?? next++
            rows.put({ name: id, key, order, row } satisfies RowRecord)
          })
          const nextMeta = change.meta ?? (known ? readMeta(known) : undefined)
          if (nextMeta) metaStore.put({ ...nextMeta, name: id, format, next } satisfies MetaRecord)
        }
        if (existing.length) existing.at(-1)!.onsuccess = finish
        else finish()
      }
      for (const seq of change.remove ?? []) outbox.delete(seq)
      // A write that a push or another tab removed meanwhile stays removed.
      for (const write of change.update ?? []) {
        const existing = outbox.get(write.seq)
        existing.onsuccess = () => {
          if (existing.result) outbox.put({ ...write, store: id } satisfies OutboxRecord)
        }
      }
      for (const seq of change.sent ?? []) {
        const existing = outbox.get(seq)
        existing.onsuccess = () => {
          const write = existing.result as OutboxRecord | undefined
          if (!write) result.gone.push(seq)
          else if (!write.sent) outbox.put({ ...write, sent: true } satisfies OutboxRecord)
        }
      }
      // A merge reads its target first, so a tab that marked the target as sent in an earlier transaction wins.
      const merges = change.merge ?? []
      const targets = merges.map(merge => outbox.get(merge.seq))
      const add = () => {
        const unmerged = new Map<number, SyncRow>()
        merges.forEach((merge, index) => {
          const target = targets[index]!.result as OutboxRecord | undefined
          if (target?.store === id && isMergeable(target)) {
            outbox.delete(merge.seq)
            return
          }
          unmerged.set(merge.index, merge.patch)
          result.unmerged.push(merge.index)
        })
        ;(change.add ?? []).forEach((write, index) => {
          const patch = unmerged.get(index)
          const added = outbox.add({ ...(patch && write.op === "update" ? { ...write, patch } : write), store: id })
          added.onsuccess = () => {
            result.seqs[index] = added.result as number
          }
        })
      }
      if (targets.length) targets.at(-1)!.onsuccess = add
      else add()
      await done(transaction)
      return result
    },
    async clear() {
      const database = await open()
      if (!(database instanceof IDBDatabase)) return database.clear()
      const transaction = database.transaction(["rows", "meta", "outbox"], "readwrite")
      for (const store of ["rows", "meta", "outbox"]) transaction.objectStore(store).clear()
      await done(transaction)
    },
  }
}

export { createIndexedDBStorage }
