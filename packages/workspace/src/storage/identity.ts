import type { WorkspaceStore } from "../core/types.ts"

const aliases = new WeakMap<object, object>()
// Once an identity has been used as an alias target, keep it as the queue
// owner if that target is later wrapped by another facade.
const stableIdentities = new WeakSet<object>()

export function workspaceStoreIdentity(store: Pick<WorkspaceStore, "getMeta">): object {
  let identity: object = store
  const seen = new Set<object>()
  while (true) {
    const next = aliases.get(identity)
    if (!next || seen.has(next)) return identity
    seen.add(identity)
    identity = next
  }
}

// Wrappers share volatile metadata while retaining their own mutation guards.
export function registerWorkspaceStoreAlias(alias: WorkspaceStore, store: WorkspaceStore): void {
  const aliasIdentity = workspaceStoreIdentity(alias)
  const storeIdentity = workspaceStoreIdentity(store)
  if (aliasIdentity === storeIdentity) return

  // Preserve an identity that already owns queued work when its target is
  // promoted. Point the new target back to that identity instead of moving
  // existing callers onto a different queue.
  if (stableIdentities.has(aliasIdentity)) aliases.set(storeIdentity, aliasIdentity)
  else {
    aliases.set(aliasIdentity, storeIdentity)
    stableIdentities.add(storeIdentity)
  }
}
