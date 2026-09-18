import { normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { workspaceStoreIdentity } from "../storage/identity.ts"
import type { WorkspaceStore } from "../core/types.ts"

// Retain ownership and retirement evidence when metadata persistence is unavailable.
type OwnerRecord = WorkspaceFileOwner & { removing?: boolean, revision?: string, checkpoint?: string }
const activeCheckpoints = new WeakMap<object, Map<string, string>>()
const checkpointMetaKey = (path: string) => `workspace-file-checkpoint:${encodeURIComponent(normalizeWorkspacePath(path))}`
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

// A pending checkpoint survives rollback even when all later metadata writes fail.
export async function beginWorkspaceFileCheckpoint(store: WorkspaceStore, path: string): Promise<string | undefined> {
  if (!store.getMeta || !store.setMeta) return undefined
  const token = crypto.randomUUID()
  const current = await store.getMeta(checkpointMetaKey(path))
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Checkpoint metadata is an untyped persistence boundary.
  const previous = current && typeof current === "object"
    ? "committed" in current && current.committed === true && "token" in current ? current.token
      : "previous" in current ? current.previous : undefined
    : undefined
  await store.setMeta(checkpointMetaKey(path), { token, committed: false, previous })
  const identity = workspaceStoreIdentity(store)
  let checkpoints = activeCheckpoints.get(identity)
  if (!checkpoints) {
    checkpoints = new Map()
    activeCheckpoints.set(identity, checkpoints)
  }
  checkpoints.set(normalizeWorkspacePath(path), token)
  return token
}

export function endWorkspaceFileCheckpoint(store: WorkspaceStore, path: string): void {
  activeCheckpoints.get(workspaceStoreIdentity(store))?.delete(normalizeWorkspacePath(path))
}

export async function commitWorkspaceFileCheckpoint(store: WorkspaceStore, path: string, token: string | undefined): Promise<void> {
  if (token) await store.setMeta!(checkpointMetaKey(path), { token, committed: true })
}

export async function recordWorkspaceFileOwner(store: WorkspaceStore, path: string, owner: OwnerRecord): Promise<void> {
  const checkpoint = activeCheckpoints.get(workspaceStoreIdentity(store))?.get(normalizeWorkspacePath(path))
  if (checkpoint) owner = { ...owner, checkpoint }
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
  if ("checkpoint" in value && value.checkpoint !== activeCheckpoints.get(workspaceStoreIdentity(store))?.get(normalizeWorkspacePath(path))) {
    const checkpoint = await store.getMeta?.(checkpointMetaKey(path))
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Checkpoint metadata is an untyped persistence boundary.
    if (!checkpoint || typeof checkpoint !== "object"
      || !(("token" in checkpoint && checkpoint.token === value.checkpoint && "committed" in checkpoint && checkpoint.committed === true)
        || ("previous" in checkpoint && checkpoint.previous === value.checkpoint))) {
      if (retireInvalidRemoval) await removeWorkspaceFileOwner(store, path)
      return undefined
    }
  }
  // Recover an interrupted deletion only while the original file version remains.
  if ("removing" in value && value.removing === true) {
    const current = await store.stat(path)
    if (current?.type === "file" && (!("revision" in value) || !value.revision || !current.revision)) {
      throw new Error(`[vitehub] Cannot retry interrupted removal without a file revision: ${path}. Inspect the file and remove it explicitly if cleanup is still needed.`)
    }
    const remaining = current?.type === "file" ? await store.readFile(path) : undefined
    if (current?.type !== "file" || !("revision" in value) || current.revision !== value.revision || !("digest" in value) || !value.digest || !remaining || await sha256(remaining.content) !== value.digest) {
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
export async function markWorkspaceFileRemoval(store: WorkspaceStore, path: string): Promise<void> {
  const owner = await readWorkspaceFileOwner(store, path)
  // Persist retry evidence before retiring the active owner. Recovery never needs
  // a provider read or metadata write while the provider is unavailable.
  if (owner) {
    const revision = (await store.stat(path))?.revision
    const removal: OwnerRecord = { ...owner, removing: true }
    if (revision) removal.revision = revision
    await recordWorkspaceFileOwner(store, path, removal)
  }
}

// Call inside the Store mutation queue after validating ownership.
export async function removeWorkspaceOwnedFile(store: WorkspaceStore, path: string): Promise<void> {
  await markWorkspaceFileRemoval(store, path)
  await store.rm(path, { force: true })
  await removeWorkspaceFileOwner(store, path)
}
