import type { WorkspaceStore } from "../core/types.ts"

const aliases = new WeakMap<object, object>()

export function workspaceStoreIdentity(store: Pick<WorkspaceStore, "getMeta">): object {
  return aliases.get(store) ?? store
}

// Wrappers share volatile metadata while retaining their own mutation guards.
export function registerWorkspaceStoreAlias(alias: WorkspaceStore, store: WorkspaceStore): void {
  aliases.set(alias, workspaceStoreIdentity(store))
}
