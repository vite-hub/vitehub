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
 * `drop`: the copies of these keys are gone and must not show. `load`: copies for these keys came from the disk.
 * `reset`: every copy and every answer in memory is gone, so each read shows its default and calls its loader again.
 */
export type DeviceEvent = { type: "drop" | "load", keys: string[] } | { type: "reset" }

/** The device of one page. `openDevice()` and `useStoredData()` use the device of the browser tab. */
export interface Device {
  open: (options?: OpenDeviceOptions) => Promise<void>
  /** `true` once the page called `open()`, also before the stored copies are in memory. */
  opened: () => boolean
  setAccount: (account: string | null) => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  clear: () => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  inspect: () => DeviceInspection
  /**
   * Changes each time the copies and the answers in memory stop being valid: another account or a sign-out after the
   * page named an account, a clear, or such a change in another tab. The answer of a loader call that started in an
   * older epoch must not show.
   */
  epoch: () => number
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

/** A random id for a new generation of the disk. */
function newGeneration(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("")
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
  /** The meta that this tab expects on the disk. A write applies only when the disk still has its generation. */
  let stored: DeviceMeta | undefined
  /** The account that this page named. `undefined` before it calls `setAccount()`, or after another tab named another account. */
  let named: string | null | undefined
  /** The account of the latest `setAccount()` call, also while the device opens. */
  let requested: string | null | undefined
  /**
   * Changes each time the copies and the answers in memory stop being valid. Nothing that started in an older epoch
   * reaches the screen or the disk: not a loader answer, and not the copies of a disk read.
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
    if (event.type !== "reset" && !event.keys.length) return
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

  /** Forgets every copy and answer in memory, and tells the reads to start over. */
  function invalidate(): void {
    epoch++
    entries.clear()
    dirty.clear()
    emit({ type: "reset" })
  }

  /** Writes `change` when the disk still has the generation `expected`. */
  async function persist(target: DeviceStorage, expected: DeviceMeta, change: DeviceChange): Promise<void> {
    const found = await target.write(expected, change)
    // The change applied, or this tab heard of the new generation in the meantime and dropped what it had.
    if (found?.generation === expected.generation || stored?.generation !== expected.generation) return
    // Another tab cleared the device, named an account, or opened another version, and this tab missed its message.
    stored = found
    // Another build owns the disk. The copies in memory still fit this build and its account, and this tab stops writing.
    if (found && found.account === named && found.version !== version) return
    // Another account: this tab writes again only after it names an account. The same account: it writes its next answers.
    if (found?.account !== named) named = undefined
    invalidate()
  }

  /** Writes the dirty keys in one change, after the changes that are already queued. */
  function flush(): void {
    if (flushQueued || !dirty.size || !persisting()) return
    flushQueued = true
    enqueue(async () => {
      flushQueued = false
      const target = storage
      const expected = stored
      if (!target || !expected || !persisting()) return
      const puts: StoredEntry[] = []
      const deletes: string[] = []
      for (const key of dirty) {
        const entry = entries.get(key)
        if (entry) puts.push({ key, json: entry.json, storedAt: entry.storedAt, expiresAt: entry.expiresAt, bytes: entry.bytes })
        else deletes.push(key)
      }
      dirty.clear()
      if (puts.length || deletes.length) await persist(target, expected, { puts, deletes, maxBytes })
    }).catch(backgroundFailure)
  }

  /** Deletes the oldest copies in memory until this tab is under the size cap. Returns their keys. */
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

  function receive(message: DeviceMessage): void {
    // The disk changed: this tab writes with its new generation, or not at all.
    if (message.meta) stored = message.meta
    if (message.type === "account" && message.account === named && message.version === version) {
      // Another tab started this tab's account over on the disk. This tab writes its copies again.
      if (!message.meta) return
      for (const key of entries.keys()) dirty.add(key)
      return flush()
    }
    // Another tab signed in as another account, signed out, or cleared the device. This tab drops everything, also the
    // answers of loader calls that still run. After another account, it writes again only after it names an account.
    if (message.type === "account") named = undefined
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
    const started = epoch
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
    if (epoch === started) publish(found.storage, found.meta, found.entries)
    // Another tab cleared the device or named another account while this tab read the disk. The copies that this tab
    // read are of an older generation. The message of the other tab has the meta, when it changed the disk.
    else stored ??= found.meta
    // The page named its account before it opened the device. The disk starts over when it holds another account.
    if (named !== undefined && (stored?.account !== named || stored.version !== version)) {
      void startOver({ account: named, version, generation: newGeneration() }).then(([error]) => error && warnOnce("storage", error))
      return
    }
    flush()
  }

  /** Takes the copies that the disk had when the device opened. */
  function publish(target: DeviceStorage, meta: DeviceMeta | undefined, found: StoredEntry[]): void {
    if (!meta) return
    if (meta.version !== version) {
      // Copies of another version can have another shape. The disk starts over for this version, and the account stays.
      const next = { account: meta.account, version, generation: newGeneration() }
      stored = next
      enqueue(() => target.reset(next)).catch(backgroundFailure)
      return
    }
    stored = meta
    // Copies of an account other than the one that the page asked for would show for a moment. Leave them out.
    const usable = meta.account !== null && (requested === undefined || requested === meta.account)
    const time = now()
    const loaded: string[] = []
    const deletes: string[] = []
    for (const entry of usable ? found : []) {
      if (entry.expiresAt <= time) deletes.push(entry.key)
      // An answer that this page got while the device opened is newer.
      else if (!entries.has(entry.key)) {
        entries.set(entry.key, { ...entry, account: meta.account ?? undefined })
        loaded.push(entry.key)
      }
    }
    deletes.push(...evict())
    if (deletes.length) enqueue(() => persist(target, meta, { puts: [], deletes, maxBytes })).catch(backgroundFailure)
    emit({ type: "load", keys: loaded.filter(key => entries.has(key)) })
  }

  /** Deletes every copy on the disk and gives it `meta`, then writes the copies of this page. Tells the other tabs. */
  async function startOver(meta: DeviceMeta): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    const target = storage
    if (!target) {
      options.channel.post({ type: "account", account: meta.account, version: meta.version, meta: undefined })
      return ok
    }
    stored = meta
    for (const key of entries.keys()) dirty.add(key)
    try {
      await enqueue(() => {
        const change = target.reset(meta)
        // After the change starts, so that the writes of other tabs for the new generation come after it.
        options.channel.post({ type: "account", account: meta.account, version: meta.version, meta })
        return change
      })
    }
    catch (cause) {
      stored = undefined
      return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the copies of the previous account", cause }), undefined]
    }
    flush()
    await queue
    return ok
  }

  /** The same account as before: its copies stay, and the answers of this page join them. */
  async function keep(account: string | null): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    if (account === null) return ok
    for (const entry of entries.values()) {
      if (entry.account !== undefined) continue
      entry.account = account
      dirty.add(entry.key)
    }
    if (!storage) return ok
    if (stored?.account !== account || stored.version !== version) return startOver({ account, version, generation: newGeneration() })
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
    const first = named === undefined
    const same = first ? account !== null && account === stored?.account : account === named
    named = account
    if (same) return keep(account)
    if (first) {
      // The first account of this page. The answers that it got, and the loader calls that still run, came with the
      // same session, so they are of this account. The copies of the last visit go.
      const dropped: string[] = []
      for (const entry of entries.values()) {
        if (entry.account === undefined && account !== null) entry.account = account
        else {
          entries.delete(entry.key)
          dropped.push(entry.key)
        }
      }
      emit({ type: "drop", keys: dropped })
    }
    // Another account, or a sign-out, after this page named an account. Everything of the previous account goes, also
    // the answers of loader calls that still run, and each read calls its loader again.
    else invalidate()
    return startOver({ account, version, generation: newGeneration() })
  }

  async function clear(): Promise<Result<void, "DEVICE_STORAGE_FAILED">> {
    if (opening) await opening
    invalidate()
    const target = storage
    if (!target) {
      options.channel.post({ type: "clear", meta: undefined })
      return ok
    }
    try {
      await enqueue(async () => {
        const meta = await target.clear(newGeneration())
        if (meta) stored = meta
        options.channel.post({ type: "clear", meta })
      })
    }
    catch (cause) {
      // The other tabs still drop their copies.
      options.channel.post({ type: "clear", meta: undefined })
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
