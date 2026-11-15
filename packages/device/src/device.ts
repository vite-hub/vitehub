import { deviceErrors, warn } from "./errors.ts"
import { browserChannel, openIndexedDB } from "./indexeddb.ts"

import type { Result, ResultError } from "@vite-hub/runtime"
import type { DeviceChannel, DeviceMessage, DeviceMeta, DeviceStorage, StoredEntry } from "./storage.ts"

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

/** `drop`: the copies of these keys are gone and must not show. `load`: copies for these keys came from the disk. */
export interface DeviceEvent {
  type: "drop" | "load"
  keys: string[]
}

/** The device of one page. `openDevice()` and `useStoredData()` use the device of the browser tab. */
export interface Device {
  open: (options?: OpenDeviceOptions) => Promise<void>
  /** `true` once the page called `open()`, also before the stored copies are in memory. */
  opened: () => boolean
  setAccount: (account: string | null) => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  clear: () => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  inspect: () => DeviceInspection
  /** The stored copy of `key` that is at most `maxAge` milliseconds old. */
  read: (key: string, maxAge: number) => { value: unknown, storedAt: number } | undefined
  /** Keeps `value` as the copy of `key`. It goes to the disk once an account is named. */
  write: (key: string, value: unknown, maxAge: number) => void
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
  /** The account of the copy. `undefined` for an answer that this page got before it named an account. */
  account: string | undefined
}

/** The device keeps at most 5 MB of JSON. `openDevice()` reads all of it before the app mounts. */
const maxDeviceBytes = 5 * 1024 * 1024
/** `openDevice()` waits at most 1 second for IndexedDB, so a slow or stuck browser does not stop the app. */
const openTimeout = 1000

const encoder = /*#__PURE__*/ new TextEncoder()
const ok: Result<void, "DEVICE_STORAGE_FAILED"> = [undefined, undefined]

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

export function createDevice(options: DeviceOptions): Device {
  const now = options.now ?? (() => Date.now())
  const maxBytes = options.maxBytes ?? maxDeviceBytes
  const entries = new Map<string, MemoryEntry>()
  /** Keys whose copy changed in memory and not yet on the disk. */
  const dirty = new Set<string>()
  const listeners = new Set<(event: DeviceEvent) => void>()
  const warned = new Set<string>()
  let storage: DeviceStorage | undefined
  let opening: Promise<void> | undefined
  let version = ""
  /** The meta that this tab expects on the disk. `undefined` on a new device, or after another tab changed it. */
  let stored: DeviceMeta | undefined
  /** The account that this page named. `undefined` before it calls `setAccount()`. */
  let named: string | null | undefined
  /** The account of the latest `setAccount()` call, also while the device opens. */
  let requested: string | null | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let flushQueued = false
  const stopReceiving = options.channel.receive(receive)

  function warnOnce(id: string, error: ResultError): void {
    if (warned.has(id)) return
    warned.add(id)
    warn(error)
  }

  function emit(event: DeviceEvent): void {
    if (!event.keys.length) return
    for (const listener of listeners) listener(event)
  }

  /** Runs storage changes one after another, in the order that the page made them. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  function persisting(): boolean {
    return storage !== undefined && typeof named === "string" && stored?.account === named && stored.version === version
  }

  function backgroundFailure(cause: unknown): void {
    warnOnce("storage", deviceErrors.DEVICE_STORAGE_FAILED({ action: "store a copy", cause }))
  }

  /** Writes the dirty keys in one change, after the changes that are already queued. */
  function flush(): void {
    if (flushQueued || !dirty.size || !persisting()) return
    flushQueued = true
    enqueue(async () => {
      flushQueued = false
      const target = storage
      if (!target || !persisting() || typeof named !== "string") return
      const meta: DeviceMeta = { account: named, version }
      const puts: StoredEntry[] = []
      const deletes: string[] = []
      for (const key of dirty) {
        const entry = entries.get(key)
        if (entry) puts.push({ key, json: entry.json, storedAt: entry.storedAt, expiresAt: entry.expiresAt, bytes: entry.bytes })
        else deletes.push(key)
      }
      dirty.clear()
      // Another tab named another account or opened another version. Its message tells this tab what to do.
      if (!await target.write(meta, puts, deletes)) stored = undefined
    }).catch(backgroundFailure)
  }

  /** Deletes the oldest copies until the device is under its size cap. Returns their keys. */
  function evict(keep?: string): string[] {
    let total = 0
    for (const entry of entries.values()) total += entry.bytes
    if (total <= maxBytes) return []
    const evicted: string[] = []
    for (const entry of [...entries.values()].sort((a, b) => a.storedAt - b.storedAt)) {
      if (total <= maxBytes) break
      if (entry.key === keep) continue
      entries.delete(entry.key)
      total -= entry.bytes
      evicted.push(entry.key)
    }
    return evicted
  }

  /** Forgets every copy in memory, and tells the reads to stop showing them. */
  function dropAll(): void {
    const keys = [...entries.keys()]
    entries.clear()
    dirty.clear()
    emit({ type: "drop", keys })
  }

  function receive(message: DeviceMessage): void {
    if (message.type === "clear") return dropAll()
    stored = { account: message.account, version: message.version }
    if (message.account === named && message.version === version) {
      // Another tab started this account over, and this tab has copies of the same account.
      for (const key of entries.keys()) dirty.add(key)
      return flush()
    }
    // Another tab signed in as another account, or out. This tab keeps nothing, and writes again only after it names an
    // account itself.
    named = undefined
    dropAll()
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
    let timer: ReturnType<typeof setTimeout> | undefined
    const connecting = connect()
    const found = await Promise.race([connecting, new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, options.openTimeout ?? openTimeout, undefined)
    })])
    clearTimeout(timer)
    // Without IndexedDB, or when it answers too late, the page keeps its copies in memory.
    if (!found) {
      void connecting.then(late => late?.storage.close())
      return
    }
    storage = found.storage
    const { meta } = found
    if (meta && meta.version !== version) {
      stored = { account: meta.account, version }
      const target = found.storage
      enqueue(() => target.reset({ account: meta.account, version })).catch(backgroundFailure)
    }
    else if (meta) {
      stored = meta
      // Copies of an account other than the one that the page asked for would show for a moment. Leave them out.
      const usable = meta.account !== null && (requested === undefined || requested === meta.account)
      const time = now()
      const loaded: string[] = []
      const deletes: string[] = []
      for (const entry of usable ? found.entries : []) {
        if (entry.expiresAt <= time) deletes.push(entry.key)
        // An answer that this page got while the device opened is newer.
        else if (!entries.has(entry.key)) {
          entries.set(entry.key, { ...entry, account: meta.account ?? undefined })
          loaded.push(entry.key)
        }
      }
      deletes.push(...evict())
      if (deletes.length) enqueue(() => found.storage.write(meta, [], deletes)).catch(backgroundFailure)
      emit({ type: "load", keys: loaded.filter(key => entries.has(key)) })
    }
    // The page named its account before it opened the device. The disk starts over when it holds another account.
    if (named !== undefined && (stored?.account !== named || stored.version !== version)) {
      void reset({ account: named, version }, found.storage).then(([error]) => error && warnOnce("storage", error))
      return
    }
    flush()
  }

  async function reset(meta: DeviceMeta, target: DeviceStorage): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    stored = meta
    for (const key of entries.keys()) dirty.add(key)
    try {
      await enqueue(() => target.reset(meta))
    }
    catch (cause) {
      stored = undefined
      return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the copies of the previous account", cause }), undefined]
    }
    flush()
    await queue
    return ok
  }

  async function setAccount(account: string | null): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    checkAccount(account)
    requested = account
    if (opening) await opening
    // A later call decides.
    if (requested !== account) return ok
    const previous = named !== undefined ? named : (stored?.account ?? null)
    named = account
    if (account !== null && account === previous) {
      // The same account: the copies from the last visit stay, and the answers of this page join them.
      for (const entry of entries.values()) {
        if (entry.account !== undefined) continue
        entry.account = account
        dirty.add(entry.key)
      }
      if (!storage) return ok
      if (stored?.account !== account || stored.version !== version) return reset({ account, version }, storage)
      flush()
      await queue
      return ok
    }
    // Another account, or a sign-out. The answers that this page got before it named an account are of the new
    // account, because they came with the same session. Every other copy goes.
    const dropped: string[] = []
    for (const entry of entries.values()) {
      if (entry.account === undefined && account !== null) entry.account = account
      else {
        entries.delete(entry.key)
        dropped.push(entry.key)
      }
    }
    emit({ type: "drop", keys: dropped })
    options.channel.post({ type: "account", account, version })
    if (!storage) return ok
    return reset({ account, version }, storage)
  }

  async function clear(): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    if (opening) await opening
    dropAll()
    options.channel.post({ type: "clear" })
    const target = storage
    if (!target) return ok
    try {
      await enqueue(() => target.clear())
    }
    catch (cause) {
      return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the stored copies", cause }), undefined]
    }
    return ok
  }

  function write(key: string, value: unknown, maxAge: number): void {
    // After a sign-out the device keeps nothing.
    if (named === null) return
    if (!opening) warnOnce("open", deviceErrors.DEVICE_NOT_OPEN())
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
      if (entries.delete(key)) dirty.add(key)
      return flush()
    }
    const time = now()
    entries.set(key, { key, json, storedAt: time, expiresAt: time + maxAge, bytes, account: named })
    dirty.add(key)
    for (const evicted of evict(key)) dirty.add(evicted)
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
      account: named !== undefined ? named : (stored?.account ?? null),
      persisted: persisting(),
      storage: storage ? "indexeddb" : "memory",
      entries: [...entries.values()]
        .map(entry => ({ key: entry.key, storedAt: new Date(entry.storedAt), bytes: entry.bytes }))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    }),
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
      await queue
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
