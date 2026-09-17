import { workspaceStoreIdentity } from "./identity.ts"
import type { WorkspaceStore } from "../core/types.ts"

// Source writes and ownership cleanup share one queue across Store wrappers.
const workspaceStoreMutations = new WeakMap<object, Promise<void>>()

export async function withWorkspaceStoreMutation<T>(store: WorkspaceStore, operation: () => Promise<T>): Promise<T> {
  const identity = workspaceStoreIdentity(store)
  const previous = workspaceStoreMutations.get(identity) ?? Promise.resolve()
  const pending = previous.then(operation)
  const settled = pending.then(() => {}, () => {})
  workspaceStoreMutations.set(identity, settled)
  try {
    return await pending
  }
  finally {
    if (workspaceStoreMutations.get(identity) === settled) workspaceStoreMutations.delete(identity)
  }
}
