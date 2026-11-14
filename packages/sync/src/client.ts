import { syncRoute } from "./protocol.ts"
import { createBrowserEnvironment, postClear } from "./client/environment.ts"
import { createIndexedDBStorage } from "./client/indexeddb.ts"
import { createMemoryStorage } from "./client/storage.ts"
import { createSyncStore } from "./client/store.ts"
import { SyncError } from "./client/types.ts"
import { syncErrors } from "./errors.ts"

import type { SyncRow } from "./protocol.ts"
import type { SyncStorage } from "./client/storage.ts"
import type { SyncStoreWithReset } from "./client/store.ts"
import type { SyncOptions, SyncState, SyncStore } from "./client/types.ts"
import type { SyncName, SyncRowOf } from "./types.ts"

declare const __VITEHUB_APP_BASE_URL__: string | undefined

interface SharedStore {
  store: SyncStoreWithReset<SyncRow>
  users: number
}

const shared = new Map<string, SharedStore>()
let memoryStorage: SyncStorage | undefined
let indexedDBStorage: SyncStorage | undefined

const idleState: SyncState<never> = Object.freeze({ rows: Object.freeze([]), status: "idle", error: null, queued: 0, failures: Object.freeze([]), persisted: false })

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

/** The store on the server: no request, no timer, no rows. */
function createIdleStore<TRow>(): SyncStore<TRow> {
  const browserOnly = () => {
    throw syncErrors.SYNC_BROWSER_ONLY()
  }
  return {
    getState: () => idleState,
    subscribe: () => () => undefined,
    get: () => undefined,
    insert: browserOnly,
    update: browserOnly,
    delete: browserOnly,
    refresh: async () => undefined,
    retry: browserOnly,
    dismiss: () => undefined,
    destroy: () => undefined,
  }
}

/**
 * The local copy of the Sync table `server/sync/<name>.ts`. It shows the stored rows at once, pulls, and keeps them
 * fresh. Writes apply at once, survive a reload in IndexedDB, and go to the server in order. Calls with one name share
 * one store; `destroy()` ends one call, and the store stops with the last one. On the server it does nothing.
 *
 * ```ts
 * const todos = createSync("todos")
 * todos.subscribe(() => render(todos.getState().rows))
 * todos.insert({ title: "Milk" })
 * ```
 * @experimental
 */
function createSync<TName extends SyncName>(name: TName, options: SyncOptions = {}): SyncStore<SyncRowOf<TName>> {
  if (!isBrowser()) return createIdleStore()
  const url = routeOf(name, options.baseURL)
  let entry = shared.get(url)
  if (!entry) {
    entry = {
      store: createSyncStore<SyncRow>(name, {
        url,
        fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
        storage: storageFor(options.persist !== false),
        environment: createBrowserEnvironment(),
        interval: options.interval ?? 30_000,
      }),
      users: 0,
    }
    shared.set(url, entry)
  }
  entry.users++
  const { store } = entry
  const owned = new Set<() => void>()
  let open = true
  const check = () => {
    if (!open) throw syncErrors.SYNC_STORE_DESTROYED({ name })
  }
  // SAFETY: the rows of the route are the JSON rows of its table, which `SyncRowOf` names.
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
    insert: value => (check(), store.insert(value)),
    update: (key, patch) => (check(), store.update(key, patch)),
    delete: key => (check(), store.delete(key)),
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
      shared.delete(url)
    },
  } as SyncStore<SyncRowOf<TName>>
}

/**
 * Forgets every Sync row and queued write in this browser, in every tab. Call it on sign-out, so the next person on
 * the device does not see them. Writes that wait reject with `SYNC_SCOPE_CHANGED`.
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
export type { SyncErrorCode, SyncKey, SyncMutation, SyncRow, SyncScope, SyncWireError } from "./protocol.ts"
export type { SyncClientErrorCode, SyncFailure, SyncOptions, SyncState, SyncStatus, SyncStore, SyncWrite } from "./client/types.ts"
export type { SyncName, SyncRowOf } from "./types.ts"
