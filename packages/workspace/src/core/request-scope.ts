import type { AsyncLocalStorage } from "node:async_hooks"

import { registerRunScope } from "@vite-hub/runtime/internal/run-scope"

import { workspaceStoreDiscard } from "../storage/discard.ts"
import type { WorkspaceStoreDiscardCarrier } from "../storage/discard.ts"
import type { WorkspaceStore } from "./types.ts"

/** The Stores that one request staged writes in. */
interface WorkspaceRequest {
  staged: Set<WorkspaceStore>
}

type DiscardableStore = WorkspaceStore & Required<WorkspaceStoreDiscardCarrier>

// Every copy of this package in one process shares the request storage and the writers, like the Store cache.
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const storageKey = Symbol.for("vitehub.workspace.request")
const writersKey = Symbol.for("vitehub.workspace.writers")
/** Writes made outside a request and a run, such as at startup, which no request may drop. */
const outsideRequest: WorkspaceRequest = { staged: new Set() }

function requestStorage(): AsyncLocalStorage<WorkspaceRequest> | undefined {
  const existing: unknown = runtimeGlobal[storageKey]
  // SAFETY: Only this module sets the key, to an AsyncLocalStorage of Workspace requests.
  if (existing) return existing as AsyncLocalStorage<WorkspaceRequest>
  // Node, Deno, Bun, and Cloudflare Workers with `nodejs_compat` have it. Elsewhere a failed request drops nothing.
  const Storage = globalThis.process?.getBuiltinModule?.("node:async_hooks")?.AsyncLocalStorage
  if (!Storage) return
  const storage = new Storage<WorkspaceRequest>()
  runtimeGlobal[storageKey] = storage
  return storage
}

/** The requests that staged writes in each Store since its last snapshot. */
function writers(): WeakMap<WorkspaceStore, Set<WorkspaceRequest>> {
  // SAFETY: Only this module sets the key, to this WeakMap.
  return (runtimeGlobal[writersKey] ??= new WeakMap()) as WeakMap<WorkspaceStore, Set<WorkspaceRequest>>
}

function isDiscardable(store: WorkspaceStore): store is DiscardableStore {
  return typeof (store as WorkspaceStoreDiscardCarrier)[workspaceStoreDiscard] === "function"
}

const stagingMethods = ["mkdir", "rebase", "removeEmptyDirectory", "rm", "setMeta", "writeFile", "writeFileConditional", "writeFileStream"] as const

/**
 * Records which request stages writes in a Store that keeps them until `snapshot()`, for every caller of the Store:
 * Workspace methods, Source materialization, and sync. Other Stores write through and are returned as they are.
 */
export function trackStagedWrites(store: WorkspaceStore): WorkspaceStore {
  if (!isDiscardable(store)) return store
  for (const name of stagingMethods) {
    const method: unknown = store[name]
    if (typeof method !== "function") continue
    Reflect.set(store, name, (...args: unknown[]) => {
      const request = requestStorage()?.getStore() ?? outsideRequest
      if (request !== outsideRequest) request.staged.add(store)
      const staged = writers().get(store)
      if (staged) staged.add(request)
      else writers().set(store, new Set([request]))
      return Reflect.apply(method, store, args)
    })
  }
  const snapshot = store.snapshot
  store.snapshot = async (options) => {
    const result = await Reflect.apply(snapshot, store, [options])
    writers().delete(store)
    return result
  }
  return store
}

/**
 * Runs one request. When it throws, each Store that only this request staged writes in since its last snapshot drops
 * them, so a later snapshot cannot commit them. Facades that hold the Store see the same branch as a new request.
 */
export async function runWorkspaceRequest<T>(next: () => T): Promise<Awaited<T>> {
  const storage = requestStorage()
  if (!storage) return await next()
  const request: WorkspaceRequest = { staged: new Set() }
  try {
    return await storage.run(request, next)
  }
  catch (error) {
    for (const store of request.staged) {
      const staged = writers().get(store)
      if (staged?.size !== 1 || !staged.has(request) || !isDiscardable(store)) continue
      writers().delete(store)
      await store[workspaceStoreDiscard]()
    }
    throw error
  }
}

// A Schedule run and a Queue job are units of work like a request: a run that throws drops its staged writes too.
registerRunScope(runWorkspaceRequest)
