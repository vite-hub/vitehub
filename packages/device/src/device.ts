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
  setAccount: (account: string | null) => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  clear: () => Promise<Result<void, "DEVICE_STORAGE_FAILED">>
  inspect: () => DeviceInspection
  /** `true` once the page named an account or `null` in this page, and no change of another tab dropped the naming. */
  named: () => boolean
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
  /**
   * Stores `value`, the answer that says who is signed in, under `account` and names that account, in one step: the
   * answer proves its own account, so it is stored although its call started before the naming. Nothing happens when the
   * epoch changed since the call started (`since`). `null` names no account and stores nothing. Returns whether it applied.
   */
  claim: (key: string, value: unknown, maxAge: number, since: number, account: string | null) => boolean
  /** Resolves when `open()` read the disk, or at once when the device is open or `open()` was never called. */
  whenOpen: () => Promise<void>
  /** `true` while `open()` reads the disk. */
  loading: () => boolean
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
  account: string
}

type StorageResult = Result<void, "DEVICE_STORAGE_FAILED">

const maxDeviceBytes = 5 * 1024 * 1024
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

function newGeneration(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join("")
}

export function createDevice(options: DeviceOptions): Device {
  const now = options.now ?? (() => Date.now())
  const maxBytes = options.maxBytes ?? maxDeviceBytes
  const entries = new Map<string, MemoryEntry>()
  const pending = new Map<string, StoredEntry | undefined>()
  const listeners = new Set<(event: DeviceEvent) => void>()
  const warned = new Set<string>()
  let storage: DeviceStorage | undefined
  let opening: Promise<void> | undefined
  let opened = false
  let diskless = false
  let version = ""
  let meta: DeviceMeta | undefined
  let versionSeen = false
  let named: string | null | undefined
  let requested: string | null | undefined
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

  function invalidate(): void {
    epoch++
    entries.clear()
    pending.clear()
    emit({ type: "reset" })
  }

  function setMeta(next: DeviceMeta | undefined): void {
    meta = next
    if (next?.version === version) versionSeen = true
  }

  async function persist(target: DeviceStorage, expected: DeviceMeta, change: DeviceChange): Promise<void> {
    const found = await target.write(expected, change)
    if (found?.generation === expected.generation || meta !== expected) return
    adopt(found)
  }

  function adopt(found: DeviceMeta | undefined): void {
    setMeta(found)
    if (found?.account !== named) named = undefined
    invalidate()
  }

  function flush(): void {
    if (flushQueued || !pending.size) return
    flushQueued = true
    enqueue(async () => {
      flushQueued = false
      const target = storage
      const expected = meta
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

  function trim(): void {
    enqueue(async () => {
      if (storage && meta) await persist(storage, meta, { puts: [], deletes: [], maxBytes, now: now() })
    }).catch(backgroundFailure)
  }

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
    if (message.type === "account" && !message.meta && message.account === named) return
    if (message.type === "account" && message.account !== named) named = undefined
    if (message.meta) return adopt(message.meta)
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
    if (!found) {
      diskless = true
      pending.clear()
      void connecting.then(late => late?.storage.close())
      return
    }
    storage = found.storage
    if (epoch === started) take(found.meta, found.entries)
    else if (!meta) setMeta(found.meta)
    const fromPage = named !== undefined
    const account = fromPage ? named : meta?.account
    if (account === undefined) return
    const since = epoch
    void enqueue(async () => epoch === since ? ensure(account, false, fromPage) : ok).then(([error]) => error && warnOnce("storage", error))
  }

  function take(found: DeviceMeta | undefined, stored: StoredEntry[]): void {
    setMeta(found)
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
      if (!entries.has(entry.key)) {
        entries.set(entry.key, { ...entry, account: found.account })
        loaded.push(entry.key)
      }
    }
    evict()
    if (expired || total > maxBytes) trim()
    emit({ type: "load", keys: loaded.filter(key => entries.has(key)) })
  }

  async function ensure(account: string | null, announce: boolean, fromPage: boolean): Promise<StorageResult> {
    if (fromPage && named !== account) return ok
    const target = storage
    if (!target) {
      if (announce) options.channel.post({ type: "account", account, meta: undefined })
      return ok
    }
    if (meta?.account === account && meta.version !== version && versionSeen) return ok
    if (meta?.account !== account || meta.version !== version) {
      const expected = meta
      const next = { account, version, generation: newGeneration() }
      let found: DeviceMeta | undefined
      try {
        found = await target.reset(next, expected?.generation)
      }
      catch (cause) {
        options.channel.post({ type: "account", account, meta: undefined })
        return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the copies of the previous account", cause }), undefined]
      }
      if (found?.generation !== expected?.generation) {
        if (meta === expected) adopt(found)
        return ok
      }
      setMeta(next)
      options.channel.post({ type: "account", account, meta: next })
    }
    flush()
    return ok
  }

  function name(account: string | null): void {
    const previous = named
    named = account
    if (previous !== undefined || [...entries.values()].some(entry => entry.account !== account)) return invalidate()
    if (account === null) return invalidate()
    epoch++
    emit({ type: "named" })
  }

  async function setAccount(account: string | null): Promise<StorageResult> {
    checkAccount(account)
    requested = account
    if (opening && !opened) await opening
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
        setMeta(await target.clear(newGeneration()))
        options.channel.post({ type: "clear", meta })
        return ok
      }
      catch (cause) {
        options.channel.post({ type: "clear", meta: undefined })
        return [deviceErrors.DEVICE_STORAGE_FAILED({ action: "delete the stored copies", cause }), undefined]
      }
    })
  }

  function write(key: string, value: unknown, maxAge: number, since: number): void {
    if (!opening) warnOnce("open", deviceErrors.DEVICE_NOT_OPEN())
    if (since !== epoch || typeof named !== "string") return
    store(key, value, maxAge, named)
  }

  function claim(key: string, value: unknown, maxAge: number, since: number, account: string | null): boolean {
    checkAccount(account)
    if (!opening) warnOnce("open", deviceErrors.DEVICE_NOT_OPEN())
    if (since !== epoch || (opening && !opened)) return false
    const naming = account !== named
    if (naming) {
      requested = account
      name(account)
      if (epoch !== since + 1 || named !== account) return false
    }
    void enqueue(() => ensure(account, naming, true)).then(([error]) => error && warnOnce("storage", error))
    if (typeof account === "string") store(key, value, maxAge, account)
    return true
  }

  function store(key: string, value: unknown, maxAge: number, account: string): void {
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
    if (json === undefined) {
      entries.delete(key)
      if (!diskless) pending.set(key, undefined)
      return flush()
    }
    const time = now()
    const entry = { key, json, storedAt: time, expiresAt: time + maxAge, bytes }
    entries.set(key, { ...entry, account })
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
      versionSeen = false
      opening = load()
      return opening
    },
    named: () => named !== undefined,
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
    claim,
    whenOpen: async () => {
      if (opening) await opening
    },
    loading: () => opening !== undefined && !opened,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settled: async () => {
      if (opening) await opening
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
