// The stores of the browser: one per Sync name and subset, shared by every caller of the page. `createSync()` and
// `useSync()` check their options and call `openSync()`.
import { syncLiveRoute, syncRoute } from "../protocol.ts"
import { createBrowserEnvironment, postClear } from "./environment.ts"
import { createIndexedDBStorage } from "./indexeddb.ts"
import { createSyncLive } from "./live.ts"
import { createMemoryStorage } from "./storage.ts"
import { actionCalls, createSyncStore } from "./store.ts"
import { whereKey } from "./view.ts"
import { syncErrors } from "../errors.ts"

import type { SyncRow, SyncValues } from "../protocol.ts"
import type { SyncLive } from "./live.ts"
import type { SyncStorage } from "./storage.ts"
import type { SyncOptimisticAction, SyncPage, SyncStoreWithReset } from "./store.ts"
import type { SyncOptions, SyncState, SyncStore } from "./types.ts"
import type { SyncActionsOf, SyncName, SyncRowOf, SyncSubsetOf } from "../types.ts"

declare const __VITEHUB_APP_BASE_URL__: string | undefined

const storedRoutePrefix = "/api/_vitehub/sync"

interface SharedStore {
  store: SyncStoreWithReset<SyncRow>
  users: number
}

const shared = new Map<string, SharedStore>()
// Destroyed stores that still send their writes, with their store id. `clearSync()` must stop them too. One id can
// have several, when a page opens and closes the same subset again.
const draining = new Map<SyncStoreWithReset<SyncRow>, string>()
let memoryStorage: SyncStorage | undefined
let indexedDBStorage: SyncStorage | undefined
// The storages whose stored writes this page sends, with the fetch of the last `createSync()` that used each one.
const senders = new Map<SyncStorage, typeof fetch>()
// The live stream of this tab, for each `fetch` and live route. Every store of the tab shares it.
const streams = new Map<typeof fetch, Map<string, SyncLive>>()
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)
// The open stores of the page, so an optimistic action can change the stores of another name with `local.sync(name)`.
const page: SyncPage = { stores: new Set(), version: 0 }

const idleState: SyncState<never> = Object.freeze({ rows: Object.freeze([]), status: "idle", complete: false, error: null, queued: 0, failures: Object.freeze([]), persisted: false, live: false })

function isBrowser(): boolean {
  return typeof window !== "undefined"
}

function memory(): SyncStorage {
  return memoryStorage ??= createMemoryStorage()
}

function storageFor(persist: boolean): SyncStorage {
  if (!persist || typeof indexedDB === "undefined") return memory()
  return indexedDBStorage ??= createIndexedDBStorage(memory)
}

function baseOf(baseURL: string | undefined): string {
  const base = baseURL ?? (typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__)
  return base.replace(/\/+$/, "")
}

function liveOf(baseURL: string | undefined, fetch: typeof globalThis.fetch): SyncLive {
  const url = `${baseOf(baseURL)}${syncLiveRoute}`
  let byRoute = streams.get(fetch)
  if (!byRoute) streams.set(fetch, byRoute = new Map())
  let live = byRoute.get(url)
  if (!live) byRoute.set(url, live = createSyncLive({ url, fetch, environment: createBrowserEnvironment() }))
  return live
}

/**
 * Sends the writes that `storage` keeps for stores that are not open, such as a subset that the page left before its
 * writes went out. Each one gets a store that stops when its writes are sent.
 */
async function sendStored(storage: SyncStorage): Promise<void> {
  const ids = await storage.queuedIds().catch(() => [])
  for (const id of ids) {
    if (shared.has(id) || [...draining.values()].includes(id)) continue
    // The id keeps the original route and the subset, even when the HTTP route changes.
    const split = id.indexOf("?")
    const storedRoute = split < 0 ? id : id.slice(0, split)
    const nameStart = storedRoute.lastIndexOf("/")
    const name = storedRoute.slice(nameStart + 1)
    const prefix = storedRoute.slice(0, nameStart)
    const url = prefix.endsWith(storedRoutePrefix)
      ? `${prefix.slice(0, -storedRoutePrefix.length)}${syncLiveRoute}/${name}`
      : storedRoute
    const where: unknown = split < 0 ? {} : JSON.parse(id.slice(split + 1))
    const store = createSyncStore<SyncRow>(name, {
      url,
      id,
      // SAFETY: `whereKey()` wrote the subset as a JSON object of column values.
      where: where as SyncValues,
      fetch: senders.get(storage)!,
      storage,
      environment: createBrowserEnvironment(),
      interval: false,
      onStop: () => draining.delete(store),
    })
    draining.set(store, id)
    store.destroy()
  }
}

/** On the first `createSync()` of a storage, and each time the network comes back, sends its writes of closed stores. */
function startSending(storage: SyncStorage, fetch: typeof globalThis.fetch): void {
  const first = !senders.has(storage)
  if (!senders.size) {
    window.addEventListener("online", () => {
      for (const known of senders.keys()) void sendStored(known)
    })
  }
  senders.set(storage, fetch)
  if (first) void sendStored(storage)
}

/** The store on the server: no request, no timer, no rows. */
// doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- The owning openSync call supplies registry types; this SSR store returns no rows or action results.
function createIdleStore<TRow, TArgs>(): SyncStore<TRow, TArgs> {
  const browserOnly = () => {
    throw syncErrors.SYNC_BROWSER_ONLY()
  }
  return {
    getState: () => idleState,
    subscribe: () => () => undefined,
    get: () => undefined,
    pending: () => false,
    insert: browserOnly,
    update: browserOnly,
    delete: browserOnly,
    actions: actionCalls(browserOnly),
    refresh: async () => undefined,
    retry: browserOnly,
    dismiss: () => undefined,
    destroy: () => undefined,
  }
}

/** `createSync()` without the check of the `where` columns, for callers that checked them, such as `useSync()`. */
function openSync<TName extends SyncName>(name: TName, options: SyncOptions<SyncRowOf<TName>, SyncActionsOf<TName>, SyncSubsetOf<TName>>): SyncStore<SyncRowOf<TName>, SyncActionsOf<TName>> {
  if (!isBrowser()) return createIdleStore()
  const base = baseOf(options.baseURL)
  const route = syncRoute(name)
  const url = `${base}${route}`
  const storedRoute = `${base}${storedRoutePrefix}${route.slice(syncLiveRoute.length)}`
  const where: Record<string, unknown> = { ...options.where }
  const subset = whereKey(where)
  const sharedKey = subset ? `${storedRoute}?${subset}` : storedRoute
  // SAFETY: each optimistic function takes the arguments of its action, which arrive as the same JSON value.
  const actions = options.actions as Record<string, SyncOptimisticAction | undefined> | undefined
  let entry = shared.get(sharedKey)
  if (!entry) {
    const fetch = options.fetch ?? defaultFetch
    const storage = storageFor(options.persist !== false)
    entry = {
      store: createSyncStore<SyncRow>(name, {
        url,
        id: sharedKey,
        where,
        ...(actions ? { actions } : {}),
        fetch,
        storage,
        environment: createBrowserEnvironment(),
        live: liveOf(options.baseURL, fetch),
        interval: options.interval ?? 30_000,
        page,
        onStop: () => {
          if (entry) draining.delete(entry.store)
        },
      }),
      users: 0,
    }
    shared.set(sharedKey, entry)
    startSending(storage, fetch)
  }
  else if (actions) {
    entry.store.addActions(actions)
  }
  entry.users++
  const { store } = entry
  const owned = new Set<() => void>()
  let open = true
  const check = () => {
    if (!open) throw syncErrors.SYNC_STORE_DESTROYED({ name })
  }
  // SAFETY: the rows of the route are the JSON rows of its table, which `SyncRowOf` names, and its actions take the
  // arguments that `SyncActionsOf` names.
  return {
    getState: store.getState,
    subscribe(listener) {
      const stop = store.subscribe(listener)
      owned.add(stop)
      return () => {
        stop()
        owned.delete(stop)
      }
    },
    get: store.get,
    pending: store.pending,
    insert: value => (check(), store.insert(value)),
    update: (key, patch) => (check(), store.update(key, patch)),
    delete: key => (check(), store.delete(key)),
    actions: actionCalls((action, args) => (check(), store.actions[action]!(args))),
    refresh: store.refresh,
    retry: failure => (check(), store.retry(failure)),
    dismiss: failure => (check(), store.dismiss(failure)),
    destroy() {
      if (!open) return
      open = false
      for (const stop of owned) stop()
      owned.clear()
      if (--entry.users > 0) return
      shared.delete(sharedKey)
      draining.set(store, sharedKey)
      store.destroy()
    },
  } as SyncStore<SyncRowOf<TName>, SyncActionsOf<TName>>
}

/** Options of `clearSync()`. */
interface ClearSyncOptions {
  /**
   * Keeps the queued writes of each account, so writes that a person made offline go out when that person signs in
   * again. They stay hidden from other accounts, as writes of another account always are. Writes made before the first
   * pull have no account, and go. Default `false`.
   */
  keepWrites?: boolean
}

/**
 * Forgets every Sync row and queued write in this browser, in every tab, also the writes that wait for another
 * account. Call it on sign-out, so the next person on the device does not see them. Writes that wait reject with
 * `SYNC_CLEARED`. With `keepWrites: true`, the writes of each account stay queued, and their promises stay pending.
 * Active stores stay paused until an explicit `refresh()` after the identity transition.
 * @experimental
 */
async function clearSync(options: ClearSyncOptions = {}): Promise<void> {
  if (!isBrowser()) return
  const keepWrites = options.keepWrites === true
  for (const { store } of shared.values()) store.forget(keepWrites)
  for (const store of draining.keys()) store.forget(keepWrites)
  await Promise.all([memoryStorage?.clear({ keepWrites }), indexedDBStorage?.clear({ keepWrites })])
  postClear(keepWrites)
}

export { clearSync, openSync }
export type { ClearSyncOptions }
