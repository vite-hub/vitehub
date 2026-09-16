import { normalizeWorkspacePath } from "../core/path.ts"
import type { WorkspaceStore } from "../core/types.ts"

const fileOwnerMetaKey = (path: string) => `workspace-file-owner:${encodeURIComponent(normalizeWorkspacePath(path))}`

export interface WorkspaceFileOwner {
  workspace: string
  source: string
  digest?: string
}

export async function recordWorkspaceFileOwner(store: WorkspaceStore, path: string, owner: WorkspaceFileOwner): Promise<void> {
  await store.setMeta?.(fileOwnerMetaKey(path), owner)
}

export async function readWorkspaceFileOwner(store: WorkspaceStore, path: string): Promise<WorkspaceFileOwner | undefined> {
  const value = await store.getMeta?.(fileOwnerMetaKey(path))
  if (!value || typeof value !== "object" || !("workspace" in value) || typeof value.workspace !== "string"
    || !("source" in value) || typeof value.source !== "string" || ("digest" in value && value.digest !== undefined && typeof value.digest !== "string")) return undefined
  return { workspace: value.workspace, source: value.source, digest: "digest" in value && typeof value.digest === "string" ? value.digest : undefined }
}
