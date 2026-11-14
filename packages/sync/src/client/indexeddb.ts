// A small IndexedDB storage for Sync, with no dependency. One database holds every Sync store of the origin: `rows` by
// [store, key], `meta` by store, `outbox` in insertion order, with the store in `store`, and `results` of actions by
// mutation id. Each change is one transaction. A store is a route plus a subset, such as
// `/api/_vitehub/sync/comments?{"issueId":"i1"}`.
import { resultLifetime } from "./storage.ts"

import type { SyncKey, SyncRow } from "../protocol.ts"
import type { SyncMeta, SyncQueuedWrite, SyncStorage, SyncStored, SyncWriteResult } from "./storage.ts"

const databaseName = "vitehub-sync"
// The version of the database format. No format before this one shipped, so a database of another version starts empty.
const format = 5

interface MetaRecord extends SyncMeta {
  name: string
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

interface ResultRecord {
  id: string
  result: unknown
  /** When the result was stored, in milliseconds since the epoch. */
  at: number
}

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, format)
    request.onupgradeneeded = () => {
      const database = request.result
      for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name)
      database.createObjectStore("rows", { keyPath: ["name", "key"] })
      database.createObjectStore("meta", { keyPath: "name" })
      database.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("store", "store")
      database.createObjectStore("results", { keyPath: "id" }).createIndex("at", "at")
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
  if (!record) return undefined
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
      const transaction = database.transaction(["rows", "meta", "outbox", "results"], "readwrite")
      const rows = transaction.objectStore("rows")
      const metaStore = transaction.objectStore("meta")
      const outbox = transaction.objectStore("outbox")
      const result: SyncWriteResult = { seqs: [] }
      const current = metaStore.get(id)
      current.onsuccess = () => {
        const known = current.result as MetaRecord | undefined
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
          if (nextMeta) metaStore.put({ ...nextMeta, name: id, next } satisfies MetaRecord)
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
      for (const [index, write] of (change.add ?? []).entries()) {
        const added = outbox.add({ ...write, store: id })
        added.onsuccess = () => {
          result.seqs[index] = added.result as number
        }
      }
      if (change.results?.length) {
        const results = transaction.objectStore("results")
        const now = Date.now()
        const expired = results.index("at").getAllKeys(IDBKeyRange.upperBound(now - resultLifetime))
        expired.onsuccess = () => {
          for (const key of expired.result) results.delete(key)
        }
        for (const [mutationId, value] of change.results) results.put({ id: mutationId, result: value, at: now } satisfies ResultRecord)
      }
      await done(transaction)
      return result
    },
    async takeResults(ids) {
      const database = await open()
      if (!(database instanceof IDBDatabase)) return database.takeResults(ids)
      const transaction = database.transaction("results", "readwrite")
      const results = transaction.objectStore("results")
      const found = new Map<string, unknown>()
      for (const mutationId of ids) {
        const existing = results.get(mutationId)
        existing.onsuccess = () => {
          const record = existing.result as ResultRecord | undefined
          if (!record) return
          found.set(mutationId, record.result)
          results.delete(mutationId)
        }
      }
      await done(transaction)
      return found
    },
    async queuedIds() {
      const database = await open()
      if (!(database instanceof IDBDatabase)) return database.queuedIds()
      const transaction = database.transaction("outbox", "readonly")
      const ids: string[] = []
      const scan = transaction.objectStore("outbox").index("store").openKeyCursor(null, "nextunique")
      scan.onsuccess = () => {
        const cursor = scan.result
        if (!cursor) return
        ids.push(String(cursor.key))
        cursor.continue()
      }
      await done(transaction)
      return ids
    },
    async clear() {
      const database = await open()
      if (!(database instanceof IDBDatabase)) return database.clear()
      const transaction = database.transaction(["rows", "meta", "outbox", "results"], "readwrite")
      for (const store of ["rows", "meta", "outbox", "results"]) transaction.objectStore(store).clear()
      await done(transaction)
    },
  }
}

export { createIndexedDBStorage }
