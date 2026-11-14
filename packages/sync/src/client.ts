import { syncRoute } from "./protocol.ts"
import { createBrowserEnvironment, postClear } from "./client/environment.ts"
import { createIndexedDBStorage } from "./client/indexeddb.ts"
import { createMemoryStorage } from "./client/storage.ts"
import { actionCalls, createSyncStore } from "./client/store.ts"
import { SyncError } from "./client/types.ts"
import { whereKey } from "./client/view.ts"
import { syncErrors } from "./errors.ts"

import type { SyncRow, SyncValues } from "./protocol.ts"
import type { SyncStorage } from "./client/storage.ts"
import type { SyncOptimisticAction, SyncStoreWithReset } from "./client/store.ts"
import type { SyncOptions, SyncState, SyncStore } from "./client/types.ts"
import type { SyncActionsOf, SyncName, SyncRowOf } from "./types.ts"

declare const __VITEHUB_APP_BASE_URL__: string | undefined

interface SharedStore {
  store: SyncStoreWithReset<SyncRow>
  users: number
}

const shared = new Map<string, SharedStore>()
let memoryStorage: SyncStorage | undefined
let indexedDBStorage: SyncStorage | undefined
// The storages whose stored writes this page sends, with the fetch of the last `createSync()` that used each one.
const senders = new Map<SyncStorage, typeof fetch>()

const idleState: SyncState<never> = Object.freeze({ rows: Object.freeze([]), status: "idle", error: null, queued: 0, failures: Object.freeze([]), persisted: false, live: false })

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

function routeOf(name: string, baseURL: string | undefined): string {
  const base = baseURL ?? (typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__)
  return `${base.replace(/\/+$/, "")}${syncRoute(name)}`
}

/**
 * Sends the writes that `storage` keeps for stores that are not open, such as a subset that the page left before its
 * writes went out. Each one gets a store that stops when its writes are sent.
 */
async function sendStored(storage: SyncStorage): Promise<void> {
  const ids = await storage.queuedIds().catch(() => [])
  for (const id of ids) {
    if (shared.has(id)) continue
    // The id is the route, and `?` with the subset as JSON when there is one. See `createSyncStore()`.
    const split = id.indexOf("?")
    const url = split < 0 ? id : id.slice(0, split)
    const where: unknown = split < 0 ? {} : JSON.parse(id.slice(split + 1))
    createSyncStore(url.slice(url.lastIndexOf("/") + 1), {
      url,
      // SAFETY: `whereKey()` wrote the subset as a JSON object of column values.
      where: where as SyncValues,
      fetch: senders.get(storage)!,
      storage,
      environment: createBrowserEnvironment(),
      interval: false,
    }).destroy()
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

/**
 * The local copy of the Sync table `server/sync/<name>.ts`. It shows the stored rows at once, pulls, and keeps them
 * fresh, live while the page shows. Writes and actions apply at once, survive a reload in IndexedDB, and go to the
 * server in order. Calls with one name and subset share one store; `destroy()` ends one call, and the store stops with
 * the last one, once its queued writes are sent. On the server it does nothing.
 *
 * ```ts
 * const todos = createSync("todos")
 * todos.subscribe(() => render(todos.getState().rows))
 * todos.insert({ title: "Milk" })
 * todos.actions.complete({ id })
 *
 * const comments = createSync("comments", { where: { issueId } })
 * ```
 * @experimental
 */
function createSync<TName extends SyncName>(name: TName, options: SyncOptions<SyncRowOf<TName>, SyncActionsOf<TName>> = {}): SyncStore<SyncRowOf<TName>, SyncActionsOf<TName>> {
  if (!isBrowser()) return createIdleStore()
  const url = routeOf(name, options.baseURL)
  const where: Record<string, unknown> = { ...options.where }
  const subset = whereKey(where)
  const sharedKey = subset ? `${url}?${subset}` : url
  // SAFETY: each optimistic function takes the arguments of its action, which arrive as the same JSON value.
  const actions = options.actions as Record<string, SyncOptimisticAction | undefined> | undefined
  let entry = shared.get(sharedKey)
  if (!entry) {
    const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    const storage = storageFor(options.persist !== false)
    entry = {
      store: createSyncStore<SyncRow>(name, {
        url,
        where,
        ...(actions ? { actions } : {}),
        fetch,
        storage,
        environment: createBrowserEnvironment(),
        interval: options.interval ?? 30_000,
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
      store.destroy()
      shared.delete(sharedKey)
    },
  } as SyncStore<SyncRowOf<TName>, SyncActionsOf<TName>>
}

/**
 * Forgets every Sync row and queued write in this browser, in every tab, also the writes that wait for another
 * account. Call it on sign-out, so the next person on the device does not see them. Writes that wait reject with
 * `SYNC_CLEARED`.
 * @experimental
 */
async function clearSync(): Promise<void> {
  if (!isBrowser()) return
  for (const { store } of shared.values()) store.forget()
  await Promise.all([memoryStorage?.clear(), indexedDBStorage?.clear()])
  postClear()
  for (const { store } of shared.values()) void store.refresh()
}

export { clearSync, createSync, SyncError }
export { syncRoute } from "./protocol.ts"
export type { SyncErrorCode, SyncKey, SyncMutation, SyncRow, SyncScope, SyncValues, SyncWireError } from "./protocol.ts"
export type { SyncActionCalls, SyncClientErrorCode, SyncFailure, SyncLocal, SyncOptimisticActions, SyncOptions, SyncState, SyncStatus, SyncStore, SyncWrite } from "./client/types.ts"
export type { SyncActionsOf, SyncJsonRow, SyncName, SyncRowOf } from "./types.ts"
