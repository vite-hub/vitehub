import type { WorkspaceDefinition, WorkspaceStore } from "./types.ts"

// One process can load two copies of this package, for example one for the app and one for Realtime.
// The cache lives on globalThis so that both copies use one Store per definition, like the registry.
const workspaceStoreCacheKey = Symbol.for("vitehub.workspace.storeCache")

type WorkspaceStoreCacheGlobal = typeof globalThis & Record<symbol, WeakMap<WorkspaceDefinition, WorkspaceStore> | undefined>

function storeByDefinition(): WeakMap<WorkspaceDefinition, WorkspaceStore> {
  const scope = globalThis as WorkspaceStoreCacheGlobal
  return scope[workspaceStoreCacheKey] ??= new WeakMap<WorkspaceDefinition, WorkspaceStore>()
}

export function getCachedWorkspaceStore(definition: WorkspaceDefinition, create: () => WorkspaceStore): WorkspaceStore {
  const cache = storeByDefinition()
  let store = cache.get(definition)
  if (!store) {
    store = create()
    cache.set(definition, store)
  }
  return store
}

export function invalidateCachedWorkspaceStore(definition: WorkspaceDefinition): void {
  storeByDefinition().delete(definition)
}

export function resetWorkspaceStoreCache(): void {
  const scope = globalThis as WorkspaceStoreCacheGlobal
  scope[workspaceStoreCacheKey] = new WeakMap<WorkspaceDefinition, WorkspaceStore>()
}
