import type { WorkspaceDefinition, WorkspaceStore } from "./types.ts"

let storeByDefinition = new WeakMap<WorkspaceDefinition, WorkspaceStore>()

export function getCachedWorkspaceStore(definition: WorkspaceDefinition, create: () => WorkspaceStore): WorkspaceStore {
  let store = storeByDefinition.get(definition)
  if (!store) {
    store = create()
    storeByDefinition.set(definition, store)
  }
  return store
}

export function resetWorkspaceStoreCache(): void {
  storeByDefinition = new WeakMap<WorkspaceDefinition, WorkspaceStore>()
}
