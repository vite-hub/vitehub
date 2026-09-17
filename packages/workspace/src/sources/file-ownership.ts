import { normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { workspaceStoreIdentity } from "../storage/identity.ts"
import type { WorkspaceStore } from "../core/types.ts"

// Retain ownership and retirement evidence when metadata persistence is unavailable.
type OwnerRecord = WorkspaceFileOwner & { removing?: boolean, revision?: string }
const volatileOwners = new WeakMap<object, Map<string, OwnerRecord | null>>()

const fileOwnerMetaKey = (path: string) => `workspace-file-owner:${encodeURIComponent(normalizeWorkspacePath(path))}`

export interface WorkspaceFileOwner {
  workspace: string
  source: string
  digest?: string
}

function volatileFileOwners(store: WorkspaceStore) {
  const identity = workspaceStoreIdentity(store)
  let owners = volatileOwners.get(identity)
  if (!owners) {
    owners = new Map<string, OwnerRecord | null>()
    volatileOwners.set(identity, owners)
  }
  return owners
}

export async function recordWorkspaceFileOwner(store: WorkspaceStore, path: string, owner: OwnerRecord): Promise<void> {
  if (!store.getMeta || !store.setMeta) {
    volatileFileOwners(store).set(fileOwnerMetaKey(path), owner)
    return
  }
  try {
    await store.setMeta(fileOwnerMetaKey(path), owner)
    volatileOwners.get(workspaceStoreIdentity(store))?.delete(fileOwnerMetaKey(path))
  }
  catch (error) {
    volatileFileOwners(store).set(fileOwnerMetaKey(path), owner)
    throw error
  }
}

// Only cleanup inside the Store mutation queue may retire interrupted removals.
export async function readWorkspaceFileOwner(store: WorkspaceStore, path: string, retireInvalidRemoval = false): Promise<WorkspaceFileOwner | undefined> {
  const volatile = volatileOwners.get(workspaceStoreIdentity(store))?.get(fileOwnerMetaKey(path))
  const value = volatile !== undefined ? volatile : await store.getMeta?.(fileOwnerMetaKey(path))
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Metadata is an untyped persistence boundary.
  if (!value || typeof value !== "object" || !("workspace" in value) || typeof value.workspace !== "string"
    || !("source" in value) || typeof value.source !== "string" || ("digest" in value && value.digest !== undefined && typeof value.digest !== "string")) return undefined
  // Recover an interrupted deletion only while the original file version remains.
  if ("removing" in value && value.removing === true) {
    const current = await store.stat(path)
    if (current && (!("revision" in value) || !value.revision || !current.revision)) {
      throw new Error(`[vitehub] Cannot retry interrupted removal without a file revision: ${path}. Inspect the file and remove it explicitly if cleanup is still needed.`)
    }
    const remaining = current ? await store.readFile(path) : undefined
    if (!current || !("revision" in value) || current.revision !== value.revision || !("digest" in value) || !value.digest || !remaining || await sha256(remaining.content) !== value.digest) {
      if (retireInvalidRemoval) await removeWorkspaceFileOwner(store, path)
      return undefined
    }
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Normalize the optional digest from untyped Store metadata to the owner contract.
  return { workspace: value.workspace, source: value.source, digest: "digest" in value && typeof value.digest === "string" ? value.digest : undefined }
}

export async function removeWorkspaceFileOwner(store: WorkspaceStore, path: string): Promise<void> {
  const owners = volatileFileOwners(store)
  // Do not revive an owner if retiring its durable checkpoint fails.
  owners.set(fileOwnerMetaKey(path), null)
  if (store.getMeta && store.setMeta) {
    await store.setMeta(fileOwnerMetaKey(path), null)
    owners.delete(fileOwnerMetaKey(path))
  }
}

// Call inside the Store mutation queue after validating ownership.
export async function removeWorkspaceOwnedFile(store: WorkspaceStore, path: string): Promise<void> {
  const owner = await readWorkspaceFileOwner(store, path)
  // Persist retry evidence before retiring the active owner. Recovery never needs
  // a provider read or metadata write while the provider is unavailable.
  if (owner) {
    const revision = (await store.stat(path))?.revision
    const removal: OwnerRecord = { ...owner, removing: true }
    if (revision) removal.revision = revision
    await recordWorkspaceFileOwner(store, path, removal)
  }
  await store.rm(path, { force: true })
  await removeWorkspaceFileOwner(store, path)
}
