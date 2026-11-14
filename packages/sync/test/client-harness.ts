// Builds a Sync store over the fake server, an in-memory storage, and a fake browser: events, visibility, a cross-tab
// bus, and a lock that tabs on one bus share.
import { createSyncStore } from "../src/client/store.ts"
import { createMemoryStorage } from "../src/client/storage.ts"
import { createFakeSyncServer } from "./client-fake-server.ts"

import type { SyncEnvironment, SyncEvent, SyncMessage } from "../src/client/environment.ts"
import type { SyncValues } from "../src/protocol.ts"
import type { SyncStorage } from "../src/client/storage.ts"
import type { SyncOptimisticAction } from "../src/client/store.ts"
import type { SyncOptimisticActions, SyncStore } from "../src/client/types.ts"
import type { FakeSyncServer } from "./client-fake-server.ts"

export interface FakeBrowser extends SyncEnvironment {
  visible: boolean
  online: boolean
  /** Fires an event of the page, such as `online`. */
  emit: (event: SyncEvent) => void
  /** The timers that wait, with their delay. Nothing fires until `fire()`. */
  timers: { ms: number, task: () => void }[]
  /** Runs the timers that wait now, and returns their delays. */
  fire: () => number[]
}

/** What tabs of one browser share: the cross-tab messages and the locks. */
export interface FakeBus {
  tabs: Set<(message: SyncMessage) => void>
  locks: Map<string, Promise<unknown>>
}

export function createFakeBus(): FakeBus {
  return { tabs: new Set(), locks: new Map() }
}

export function createFakeBrowser(bus: FakeBus = createFakeBus()): FakeBrowser {
  const listeners = new Set<(event: SyncEvent) => void>()
  const own = new Set<(message: SyncMessage) => void>()
  const browser: FakeBrowser = {
    visible: true,
    online: true,
    emit(event) {
      if (event === "online") browser.online = true
      if (event === "offline") browser.online = false
      if (event === "visible") browser.visible = true
      if (event === "hidden") browser.visible = false
      for (const listener of listeners) listener(event)
    },
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isVisible: () => browser.visible,
    isOnline: () => browser.online,
    async lock(name, task) {
      const previous = bus.locks.get(name) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(task)
      bus.locks.set(name, current)
      return current
    },
    lead(name, task) {
      const controller = new AbortController()
      void browser.lock(name, () => controller.signal.aborted ? Promise.resolve() : task(controller.signal))
      return () => controller.abort()
    },
    post(message) {
      // A BroadcastChannel does not deliver a message to its own sender.
      for (const tab of bus.tabs) {
        if (!own.has(tab)) queueMicrotask(() => tab(structuredClone(message)))
      }
    },
    receive(listener) {
      own.add(listener)
      bus.tabs.add(listener)
      return () => {
        own.delete(listener)
        bus.tabs.delete(listener)
      }
    },
    random: () => 0.5,
    timers: [],
    schedule(task, ms) {
      const timer = { ms, task }
      browser.timers.push(timer)
      return () => {
        browser.timers = browser.timers.filter(item => item !== timer)
      }
    },
    fire() {
      const due = browser.timers.splice(0)
      for (const timer of due) timer.task()
      return due.map(timer => timer.ms)
    },
  }
  return browser
}

export interface Tab {
  store: SyncStore<Todo, TodoActions>
  browser: FakeBrowser
}

export interface Todo {
  id: string
  ownerId: string
  title: string
  done?: boolean
  teamId?: string
  listId?: string
}

/** The arguments of the actions that tests define on the fake server. */
export interface TodoActions {
  complete: { id: string }
  add: { id?: string, title: string }
  /** No fake server defines it. */
  archive: Record<string, never>
}

export interface OpenOptions {
  interval?: number | false
  fetch?: typeof fetch
  storage?: SyncStorage
  where?: SyncValues
  actions?: SyncOptimisticActions<Todo, TodoActions>
}

export interface Harness {
  server: FakeSyncServer
  storage: SyncStorage
  bus: FakeBus
  /** Opens the store in a new tab. Each tab has its own store over the shared storage. */
  open: (options?: OpenOptions) => Tab
  /** Destroys every store that `open()` made. */
  close: () => void
}

export function createHarness(): Harness {
  const server = createFakeSyncServer()
  const storage = createMemoryStorage()
  const bus = createFakeBus()
  const stores: SyncStore<Todo, TodoActions>[] = []
  return {
    server,
    storage,
    bus,
    open(options = {}) {
      const browser = createFakeBrowser(bus)
      const store = createSyncStore<Todo, TodoActions>("todos", {
        url: "/api/_vitehub/sync/todos",
        ...(options.where ? { where: options.where } : {}),
        // SAFETY: each optimistic function takes the JSON arguments of its action.
        ...(options.actions ? { actions: options.actions as Record<string, SyncOptimisticAction> } : {}),
        fetch: options.fetch ?? server.fetch,
        storage: options.storage ?? storage,
        environment: browser,
        interval: options.interval ?? false,
      })
      stores.push(store)
      return { store, browser }
    },
    close() {
      for (const store of stores.splice(0)) store.destroy()
    },
  }
}

/** Resolves once `check` passes, for state that settles after storage reads. */
export async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("The condition did not become true in time.")
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}
