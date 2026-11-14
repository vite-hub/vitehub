// A small IndexedDB storage for Sync, with no dependency. One database holds every Sync route of the origin:
// `rows` by [route, key], `meta` by route, and `outbox` in insertion order. Each change is one transaction.
import type { SyncKey, SyncRow } from "../protocol.ts"
import type { SyncMeta, SyncQueuedWrite, SyncStorage, SyncStored } from "./storage.ts"

const databaseName = "vitehub-sync"
const format = 1

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

type OutboxRecord = SyncQueuedWrite & { name: string }

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
      database.createObjectStore("rows", { keyPath: ["name", "key"] })
      database.createObjectStore("meta", { keyPath: "name" })
      database.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("name", "name")
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
  return { scope: record.scope, key: record.key, cursor: record.cursor }
}

function readWrites(records: OutboxRecord[]): SyncQueuedWrite[] {
  return records.map(({ name: _name, ...write }) => write as SyncQueuedWrite)
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
    const outbox = transaction.objectStore("outbox").index("name").getAll(id)
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
      const seqs: number[] = []
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
      for (const write of change.update ?? []) outbox.put({ ...write, name: id } satisfies OutboxRecord)
      for (const write of change.add ?? []) {
        const added = outbox.add({ ...write, name: id })
        added.onsuccess = () => seqs.push(added.result as number)
      }
      await done(transaction)
      return seqs
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
