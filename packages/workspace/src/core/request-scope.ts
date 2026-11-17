import { invalidateCachedWorkspaceStore } from "./workspace-cache.ts"
import type { AsyncLocalStorage } from "node:async_hooks"
import type { WorkspaceDefinition, WorkspaceStore } from "./types.ts"

/** The Workspaces that one request wrote to, with the Store that holds its staged writes. */
interface WorkspaceRequest {
  staged: Map<WorkspaceDefinition, WorkspaceStore>
}

// Every copy of this package in one process shares the request storage and the writers, like the Store cache.
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const storageKey = Symbol.for("vitehub.workspace.request")
const writersKey = Symbol.for("vitehub.workspace.writers")
/** Writes made outside a request, such as in a Queue job, which no request may drop. */
const outsideRequest: WorkspaceRequest = { staged: new Map() }

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

/**
 * Records a write to a Store that keeps writes staged until `snapshot()`: the GitHub and Cloudflare Artifacts Stores.
 * Other Stores write through, so a failed request has nothing to drop.
 */
export function noteWorkspaceWrite(definition: WorkspaceDefinition, store: WorkspaceStore): void {
  if (typeof store.rebase !== "function") return
  const request = requestStorage()?.getStore() ?? outsideRequest
  if (request !== outsideRequest) request.staged.set(definition, store)
  const staged = writers().get(store)
  if (staged) staged.add(request)
  else writers().set(store, new Set([request]))
}

/** Records that a snapshot committed every staged write of the Store. */
export function noteWorkspaceSnapshot(store: WorkspaceStore): void {
  writers().delete(store)
}

/**
 * Runs one request. When it fails, the cached Stores that only this request wrote to since their last snapshot are
 * dropped, so the next request loads the branch again and its snapshot cannot commit the failed request's writes.
 */
export async function runWorkspaceRequest<T>(next: () => T): Promise<Awaited<T>> {
  const storage = requestStorage()
  if (!storage) return await next()
  const request: WorkspaceRequest = { staged: new Map() }
  try {
    return await storage.run(request, next)
  }
  catch (error) {
    for (const [definition, store] of request.staged) {
      const staged = writers().get(store)
      if (staged?.size !== 1 || !staged.has(request)) continue
      writers().delete(store)
      invalidateCachedWorkspaceStore(definition, store)
    }
    throw error
  }
}
