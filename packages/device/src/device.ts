import { deviceErrors, warn } from "./errors.ts"
import { browserChannel, openIndexedDB } from "./indexeddb.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { DeviceChange, DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "./storage.ts"

/** What `inspectDevice()` returns. */
export interface DeviceInspection {
  /**
   * The account that the stored copies belong to: the account that this page named with `setDeviceAccount()`, or before
   * that, the account of the copies from the last visit. `null` when there is none.
   */
  account: string | null
  /** `true` when new copies go to IndexedDB and survive a reload. */
  persisted: boolean
  /** `indexeddb`, or `memory` when the browser has no working IndexedDB, or before `openDevice()`. */
  storage: "indexeddb" | "memory"
  /** Each stored copy, by key. */
  entries: { key: string, storedAt: Date, bytes: number }[]
}

export interface OpenDeviceOptions {
  /**
   * The version of the stored data. When it is not the version of the stored copies, the device deletes them, so a new
   * build does not show answers of an old shape. Use a build id, or a number that you change with the shape of the data.
   */
  version?: string
}

/**
 * `load`: copies for these keys came from the disk. `named`: the page named its account, so every read calls its loader
 * again and its next answer can be stored. `reset`: every copy and every answer in memory is gone, so each read shows
 * its default and calls its loader again.
 */
export type DeviceEvent = { type: "load", keys: string[] } | { type: "named" } | { type: "reset" }

/** The device of one page. `openDevice()` and `useStoredData()` use the device of the browser tab. */
export interface Device {
  open: (options?: OpenDeviceOptions) => Promise<void>
  /** `true` once the page called `open()`, also before the stored copies are in memory. */
  opened: () => boolean
  setAccount: (account: string | null) => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  clear: () => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  inspect: () => DeviceInspection
  /**
   * Changes when the page names an account, and each time the copies and the answers in memory stop being valid: another
   * account or a sign-out, a clear, or a change of the disk by another tab. A loader call keeps the epoch in which it
   * started, and `write()` stores its answer only in that same epoch.
   */
  epoch: () => number
  /** The stored copy of `key` that is at most `maxAge` milliseconds old. */
  read: (key: string, maxAge: number) => { value: unknown, storedAt: number } | undefined
  /**
   * Stores `value` as the copy of `key` when the loader call that got it started in this epoch (`since`) and the page
   * named an account. The device keeps no other answer, in memory or on the disk.
   */
  write: (key: string, value: unknown, maxAge: number, since: number) => void
  subscribe: (listener: (event: DeviceEvent) => void) => () => void
  /** Resolves when every change that the device started is on the disk or failed. */
  settled: () => Promise<void>
  close: () => void
}

export interface DeviceOptions {
  openStorage: () => Promise<DeviceStorage>
  channel: DeviceChannel
  now?: () => number
  /** The most bytes of JSON that the device keeps. */
  maxBytes?: number
  /** How long `open()` waits for the storage, in milliseconds. */
  openTimeout?: number
}

interface MemoryEntry extends StoredEntry {
  /** The account of the copy. */
  account: string
}

type StorageResult = Result<void, "DEVICE_STORAGE_FAILED">

/** The device keeps at most 5 MB of JSON. `openDevice()` reads all of it before the app mounts. */
const maxDeviceBytes = 5 * 1024 * 1024
/** `openDevice()` waits at most 1 second for IndexedDB, so a slow or stuck browser does not stop the app. */
const openTimeout = 1000

const encoder = /*#__PURE__*/ new TextEncoder()
const ok: StorageResult = [undefined, undefined]

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

export function checkAccount(account: unknown): asserts account is string | null {
  if (account !== null && (typeof account !== "string" || account === "")) throw deviceErrors.DEVICE_INVALID_ACCOUNT({ account: describe(account) })
}

export function checkKey(key: unknown): string {
  if (typeof key !== "string" || key === "") throw deviceErrors.DEVICE_INVALID_KEY({ key: describe(key) })
  return key
}

export function checkMaxAge(maxAge: unknown): number {
  if (typeof maxAge !== "number" || Number.isNaN(maxAge) || maxAge < 0) throw deviceErrors.DEVICE_INVALID_MAX_AGE({ maxAge: describe(maxAge) })
  return maxAge
}

/** A random id for a new generation of the disk. */
function newGeneration(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("")
}

export function createDevice(options: DeviceOptions): Device {
  const now = options.now ?? (() => Date.now())
  const maxBytes = options.maxBytes ?? maxDeviceBytes
  /** The copies that new reads of this tab show: the copies of the disk, and the answers that the device stores. */
  const entries = new Map<string, MemoryEntry>()
  /** The changes for the disk: a copy to put, or `undefined` to delete the key. */
  const pending = new Map<string, StoredEntry | undefined>()
  const listeners = new Set<(event: DeviceEvent) => void>()
  const warned = new Set<string>()
  let storage: DeviceStorage | undefined
  let opening: Promise<void> | undefined
  /** `true` once `open()` finished, so `setAccount()` can name the account at once. */
  let opened = false
  /** `true` when the device opened without a disk, so nothing waits to be written. */
  let diskless = false
  let version = ""
  /**
   * The meta that this tab expects on the disk. A change of this tab sets it in the queue, after its disk operation, so
   * it follows the order of the operations. A message of another tab sets it at once.
   */
  let meta: DeviceMeta | undefined
  /** The account that this page named. `undefined` before it calls `setAccount()`, or after another tab named another account. */
  let named: string | null | undefined
  /** The account of the latest `setAccount()` call, also while the device opens. */
  let requested: string | null | undefined
  /**
   * Changes when the page names an account, and when the copies and the answers in memory stop being valid. The device
   * stores an answer only when its loader call started in the current epoch, after the page named an account.
   */
  let epoch = 0
  let queue: Promise<unknown> = Promise.resolve()
  let flushQueued = false
  const stopReceiving = options.channel.receive(receive)

  function warnOnce(id: string, error: ResultError): void {
    if (warned.has(id)) return
    warned.add(id)
    warn(error)
  }

  function emit(event: DeviceEvent): void {
    if (event.type === "load" && !event.keys.length) return
    for (const listener of listeners) listener(event)
  }

  /** Runs disk operations, and the changes of `meta` that come with them, one after another in the order of the calls. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  function persisting(): boolean {
    return storage !== undefined && typeof named === "string" && meta?.account === named && meta.version === version
  }

  function backgroundFailure(cause: unknown): void {
    warnOnce("storage", deviceErrors.DEVICE_STORAGE_FAILED({ action: "store a copy", cause }))
  }

  /** Forgets every copy and answer in memory, and tells the reads to start over. */
  function invalidate(): void {
    epoch++
    entries.clear()
    pending.clear()
    emit({ type: "reset" })
  }

  /** Writes `change` when the disk still has the generation `expected`. Runs in the queue. */
  async function persist(target: DeviceStorage, expected: DeviceMeta, change: DeviceChange): Promise<void> {
    const found = await target.write(expected, change)
    // The change applied, or a message of another tab changed `meta` in the meantime and dropped what this tab had.
    if (found?.generation === expected.generation || meta !== expected) return
    adopt(found)
  }

  /**
   * Takes the meta that the disk has, after another tab changed the disk and this tab missed its message. Everything of
   * this tab is old. After another account, this tab stores again only after it names an account.
   */
  function adopt(found: DeviceMeta | undefined): void {
    meta = found
    if (found?.account !== named) named = undefined
    invalidate()
  }

  /** Writes the pending changes in one write, after the operations that are already queued. */
  function flush(): void {
    if (flushQueued || !pending.size) return
    flushQueued = true
    enqueue(async () => {
      flushQueued = false
      const target = storage
      const expected = meta
      // The changes wait for the disk to hold the account of the page.
      if (!target || !expected || !persisting()) return
      const change: DeviceChange = { puts: [], deletes: [], maxBytes, now: now() }
      for (const [key, entry] of pending) {
        if (entry) change.puts.push(entry)
        else change.deletes.push(key)
      }
      pending.clear()
      await persist(target, expected, change)
    }).catch(backgroundFailure)
  }

  /** Deletes the expired copies on the disk, and the oldest ones over the cap. The disk picks them in its transaction. */
  function trim(): void {
    enqueue(async () => {
      if (storage && meta) await persist(storage, meta, { puts: [], deletes: [], maxBytes, now: now() })
    }).catch(backgroundFailure)
  }

  /** Drops the oldest copies in the memory of this tab until it is under the size cap. The disk keeps its own cap. */
  function evict(keep?: string): void {
    let total = 0
    for (const entry of entries.values()) total += entry.bytes
    for (const entry of [...entries.values()].sort((a, b) => a.storedAt - b.storedAt)) {
      if (total <= maxBytes) return
      if (entry.key === keep) continue
      entries.delete(entry.key)
      total -= entry.bytes
    }
  }

  function receive(message: DeviceMessage): void {
    // A tab without IndexedDB named the account of this page: the disk did not change.
    if (message.type === "account" && !message.meta && message.account === named) return
    // Another tab cleared the device, started it over, or named another account. Everything of this tab is old: its
    // copies, its answers, and the loader calls that run. After another account, it stores again only after it names one.
    if (message.meta) meta = message.meta
    if (message.type === "account" && message.account !== named) named = undefined
    invalidate()
  }

  async function connect(): Promise<{ storage: DeviceStorage, meta: DeviceMeta | undefined, entries: StoredEntry[] } | undefined> {
    let opened: DeviceStorage | undefined
    try {
      opened = await options.openStorage()
      return { storage: opened, ...await opened.read() }
    }
    catch {
      opened?.close()
      return undefined
    }
  }

  async function load(): Promise<void> {
    try {
      await connectAndTake()
    }
    finally {
      opened = true
    }
  }

  async function connectAndTake(): Promise<void> {
    const started = epoch
    let timer: ReturnType<typeof setTimeout> | undefined
    const connecting = connect()
    const found = await Promise.race([connecting, new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, options.openTimeout ?? openTimeout, undefined)
    })])
    clearTimeout(timer)
    // Without IndexedDB, or when it answers too late, the page keeps its copies in memory.
    if (!found) {
      diskless = true
      pending.clear()
      void connecting.then(late => late?.storage.close())
      return
    }
    storage = found.storage
    if (epoch === started) take(found.meta, found.entries)
    // Another tab changed the disk while this tab read it. The copies that this tab read are old. The message of the
    // other tab has the new meta, when the disk changed.
    else meta ??= found.meta
    // The disk follows the page: the account that it named, or else the account of the disk, in the version of this build.
    // The account of the disk only follows what the disk had. The account that the page named is what the page knows.
    const fromPage = named !== undefined
    const account = fromPage ? named : meta?.account
    if (account === undefined) return
    // When the epoch moves before the task runs, the page named an account and queued its own start-over, or the disk
    // changed, such as a trim that found another account. Then `account` is old, and the task must not delete the disk.
    const since = epoch
    void enqueue(async () => epoch === since ? ensure(account, false, fromPage) : ok).then(([error]) => error && warnOnce("storage", error))
  }

  /** Takes the copies that the disk had when the device opened. */
  function take(found: DeviceMeta | undefined, stored: StoredEntry[]): void {
    meta = found
    // Copies of another version can have another shape, and copies of an account other than the one that the page asked
    // for would show for a moment. Leave them out.
    if (!found || found.version !== version || found.account === null || (requested !== undefined && requested !== found.account)) return
    const time = now()
    const loaded: string[] = []
    let expired = false
    let total = 0
    for (const entry of stored) {
      if (entry.expiresAt <= time) {
        expired = true
        continue
      }
      total += entry.bytes
      // An answer that this page stored while the device opened is newer.
      if (!entries.has(entry.key)) {
        entries.set(entry.key, { ...entry, account: found.account })
        loaded.push(entry.key)
      }
    }
    evict()
    if (expired || total > maxBytes) trim()
    emit({ type: "load", keys: loaded.filter(key => entries.has(key)) })
  }

  /**
   * Brings the disk to `account` in the version of this build. When the disk holds another account or version, every copy
   * goes and the disk gets a new generation, and the other tabs hear of it. Runs in the queue. In this tab it is not a
   * reset: the tab raised the epoch when it named the account, and holds no copy of another account or version.
   *
   * The reset applies only when the disk still has the generation that this tab knows. When another tab changed the
   * disk and this tab missed its message, an account that the page named (`fromPage`) tries again on the new disk while
   * the disk holds that same account. Another account on the disk, or an account that came from the disk at open, is
   * newer than what this tab knows, so the tab takes the disk as it is.
   */
  async function ensure(account: string | null, announce: boolean, fromPage: boolean): Promise<StorageResult> {
    const target = storage
    if (!target) {
      if (announce) options.channel.post({ type: "account", account, meta: undefined })
      return ok
    }
    if (meta?.account !== account || meta.version !== version) {
      const expected = meta
      const next = { account, version, generation: newGeneration() }
      let found: DeviceMeta | undefined
      try {
        found = await target.reset(next, expected?.generation)
      }
      catch (cause) {
        // The other tabs still drop what they have of another account.
        options.channel.post({ type: "account", account, meta: undefined })
        return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the copies of the previous account", cause }), undefined]
      }
      if (found?.generation !== expected?.generation) {
        // Another tab changed the disk. When its message came in the meantime, `meta` has it already.
        if (meta === expected) {
          // Another account on the disk is newer than what this tab knows, also than an account that the page named: the
          // session can have changed meanwhile. The tab stores again only after the page names an account.
          if (!fromPage || (found !== undefined && found.account !== account)) {
            adopt(found)
            return ok
          }
          meta = found
          invalidate()
        }
        // The disk still holds `account`, after a clear or in another version, and the page still names it. The tab tries
        // again on the disk as it is now.
        return fromPage && named === account ? ensure(account, announce, fromPage) : ok
      }
      meta = next
      options.channel.post({ type: "account", account, meta: next })
    }
    flush()
    return ok
  }

  /** Names `account` in memory, at once, so that loader calls that started before it are never stored. */
  function name(account: string | null): void {
    const previous = named
    named = account
    // Another account or a sign-out after the page named one, or copies of another account on the screen: everything goes.
    if (previous !== undefined || [...entries.values()].some(entry => entry.account !== account)) return invalidate()
    // The first account of the page, and the screen shows nothing of another account. The answers that came before stay
    // on the screen, and are never stored. Each read calls its loader again, so that its next answer can be stored.
    if (account === null) return
    epoch++
    emit({ type: "named" })
  }

  async function setAccount(account: string | null): Promise<StorageResult> {
    checkAccount(account)
    requested = account
    // While the device opens, the copies of the disk decide what the naming changes. Before and after, the page names
    // the account at once, so a read that starts after this call can be stored before the disk follows.
    if (opening && !opened) await opening
    // A later call decides.
    if (requested !== account) return ok
    const changed = account !== named
    if (changed) name(account)
    return enqueue(() => ensure(account, changed, true))
  }

  async function clear(): Promise<StorageResult> {
    if (opening) await opening
    invalidate()
    return enqueue(async () => {
      const target = storage
      if (!target) {
        options.channel.post({ type: "clear", meta: undefined })
        return ok
      }
      try {
        meta = await target.clear(newGeneration())
        options.channel.post({ type: "clear", meta })
        return ok
      }
      catch (cause) {
        // The other tabs still drop their copies.
        options.channel.post({ type: "clear", meta: undefined })
        return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the stored copies", cause }), undefined]
      }
    })
  }

  function write(key: string, value: unknown, maxAge: number, since: number): void {
    if (!opening) warnOnce("open", deviceErrors.DEVICE_NOT_OPEN())
    // The rule of the device: it stores an answer only when the loader call started after the page named its account, and
    // nothing made the answers old since then. Any other answer stays on the screen of this read, and nowhere else.
    if (since !== epoch || typeof named !== "string") return
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    }
    catch (cause) {
      warnOnce(`json:${key}`, deviceErrors.DEVICE_VALUE_NOT_JSON({ key, cause }))
      json = undefined
    }
    const bytes = json === undefined ? 0 : encoder.encode(json).byteLength
    if (json !== undefined && bytes > maxBytes) {
      warnOnce(`size:${key}`, deviceErrors.DEVICE_VALUE_TOO_LARGE({ key, bytes, limit: maxBytes }))
      json = undefined
    }
    // A value that the device cannot keep also removes the older copy, so a reload does not show it.
    if (json === undefined) {
      entries.delete(key)
      if (!diskless) pending.set(key, undefined)
      return flush()
    }
    const time = now()
    const entry = { key, json, storedAt: time, expiresAt: time + maxAge, bytes }
    entries.set(key, { ...entry, account: named })
    if (!diskless) pending.set(key, entry)
    evict(key)
    flush()
  }

  return {
    open(openOptions = {}) {
      const wanted = openOptions.version ?? ""
      if (opening) {
        if (wanted !== version) throw deviceErrors.DEVICE_ALREADY_OPEN({ version: wanted, open: version })
        return opening
      }
      version = wanted
      opening = load()
      return opening
    },
    opened: () => opening !== undefined,
    setAccount,
    clear,
    inspect: () => ({
      account: named !== undefined ? named : (meta?.account ?? null),
      persisted: persisting(),
      storage: storage ? "indexeddb" : "memory",
      entries: [...entries.values()]
        .map(entry => ({ key: entry.key, storedAt: new Date(entry.storedAt), bytes: entry.bytes }))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    }),
    epoch: () => epoch,
    read(key, maxAge) {
      const entry = entries.get(key)
      if (!entry || now() - entry.storedAt > maxAge) return undefined
      return { value: JSON.parse(entry.json), storedAt: entry.storedAt }
    },
    write,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settled: async () => {
      if (opening) await opening
      // A task can queue another one, such as a write after a start-over.
      for (let current = queue; ; current = queue) {
        await current
        if (current === queue) return
      }
    },
    close() {
      stopReceiving()
      listeners.clear()
      storage?.close()
    },
  }
}

let browserDevice: Device | undefined

/** The device of this browser tab. `undefined` on the server, where nothing is stored. */
export function currentDevice(): Device | undefined {
  if (typeof document === "undefined") return undefined
  browserDevice ??= createDevice({ openStorage: openIndexedDB, channel: browserChannel() })
  return browserDevice
}
