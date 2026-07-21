import { sha256 } from "../core/path.ts"

import type { WorkspaceDiff, WorkspaceEntry, WorkspaceSnapshot, WorkspaceStore } from "../core/types.ts"

export async function createCurrentSnapshotFromStore(store: WorkspaceStore, name?: string): Promise<WorkspaceSnapshot> {
  return await createSnapshotFromEntries(await store.list("", { recursive: true }), name)
}

export async function createSnapshotFromEntries(entries: WorkspaceEntry[], name?: string): Promise<WorkspaceSnapshot> {
  const snapshotEntries: WorkspaceSnapshot["entries"] = {}
  for (const entry of entries) {
    snapshotEntries[entry.path] = {
      digest: entry.digest,
      metadata: entry.metadata,
      size: entry.size,
      type: entry.type,
    }
  }

  return {
    createdAt: new Date().toISOString(),
    entries: snapshotEntries,
    id: await sha256({ entries: snapshotEntries, name, createdAt: Date.now() }),
    name,
  }
}

export function diffSnapshots(from: WorkspaceSnapshot | undefined, to: WorkspaceSnapshot): WorkspaceDiff {
  const entries: WorkspaceDiff["entries"] = []
  const keys = new Set([...Object.keys(from?.entries || {}), ...Object.keys(to.entries)])
  for (const path of [...keys].sort()) {
    const before = from?.entries[path]
    const after = to.entries[path]
    if (!before && after) entries.push({ path, type: "added", after })
    else if (before && !after) entries.push({ path, type: "removed", before })
    else if (before && after && (before.digest !== after.digest || before.type !== after.type || before.size !== after.size || JSON.stringify(before.metadata) !== JSON.stringify(after.metadata))) {
      entries.push({ path, type: "modified", before, after })
    }
  }
  return { from: from?.id, to: to.id, entries }
}
