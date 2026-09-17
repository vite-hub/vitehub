import { normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { workspaceStoreIdentity } from "../storage/identity.ts"
import type { WorkspaceStore } from "../core/types.ts"

// Stores without metadata APIs retain ownership for their lifetime.
const volatileOwners = new WeakMap<object, Map<string, WorkspaceFileOwner & { removing?: boolean }>>()

const fileOwnerMetaKey = (path: string) => `workspace-file-owner:${encodeURIComponent(normalizeWorkspacePath(path))}`

export interface WorkspaceFileOwner {
  workspace: string
  source: string
  digest?: string
}

export async function recordWorkspaceFileOwner(store: WorkspaceStore, path: string, owner: WorkspaceFileOwner & { removing?: boolean }): Promise<void> {
  if (!store.getMeta || !store.setMeta) {
    let owners = volatileOwners.get(workspaceStoreIdentity(store))
    if (!owners) {
      owners = new Map()
      volatileOwners.set(workspaceStoreIdentity(store), owners)
    }
    owners.set(fileOwnerMetaKey(path), owner)
    return
  }
  await store.setMeta(fileOwnerMetaKey(path), owner)
}

// Only cleanup inside the Store mutation queue may retire interrupted removals.
export async function readWorkspaceFileOwner(store: WorkspaceStore, path: string, retireInvalidRemoval = false): Promise<WorkspaceFileOwner | undefined> {
  const volatile = volatileOwners.get(workspaceStoreIdentity(store))?.get(fileOwnerMetaKey(path))
  const value = volatile ?? await store.getMeta?.(fileOwnerMetaKey(path))
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Metadata is an untyped persistence boundary.
  if (!value || typeof value !== "object" || !("workspace" in value) || typeof value.workspace !== "string"
    || !("source" in value) || typeof value.source !== "string" || ("digest" in value && value.digest !== undefined && typeof value.digest !== "string")) return undefined
  // An interrupted deletion retains retry evidence, but it is not an active owner.
  if ("removing" in value && value.removing === true) {
    const remaining = await store.readFile(path)
    if (!("digest" in value) || !value.digest || !remaining || await sha256(remaining.content) !== value.digest) {
      if (retireInvalidRemoval) await removeWorkspaceFileOwner(store, path)
      return undefined
    }
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Normalize the optional digest from untyped Store metadata to the owner contract.
  return { workspace: value.workspace, source: value.source, digest: "digest" in value && typeof value.digest === "string" ? value.digest : undefined }
}

export async function removeWorkspaceFileOwner(store: WorkspaceStore, path: string): Promise<void> {
  volatileOwners.get(workspaceStoreIdentity(store))?.delete(fileOwnerMetaKey(path))
  if (store.getMeta && store.setMeta) await store.setMeta(fileOwnerMetaKey(path), null)
}

// Call inside the Store mutation queue after validating ownership.
export async function removeWorkspaceOwnedFile(store: WorkspaceStore, path: string): Promise<void> {
  const owner = await readWorkspaceFileOwner(store, path)
  // Persist retry evidence before retiring the active owner. Recovery never needs
  // a provider read or metadata write while the provider is unavailable.
  if (owner) await recordWorkspaceFileOwner(store, path, { ...owner, removing: true })
  await store.rm(path, { force: true })
  await removeWorkspaceFileOwner(store, path)
}
