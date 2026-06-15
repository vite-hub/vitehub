export interface WorkspaceSourceSyncStatePath {
  digest: string
  mediaType?: string
  sourcePath: string
}

export interface WorkspaceSourceSyncState {
  configHash: string
  mountPath: string
  paths: Record<string, WorkspaceSourceSyncStatePath>
  source: string
}

export function sourceSyncMetaKey(sourceKey: string) {
  return `source:${sourceKey}:sync`
}

export function readWorkspaceSourceSyncState(value: unknown): WorkspaceSourceSyncState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const state = value as WorkspaceSourceSyncState
  if (typeof state.configHash !== "string") return
  if (typeof state.source !== "string" || typeof state.mountPath !== "string") return
  if (!state.paths || typeof state.paths !== "object" || Array.isArray(state.paths)) return

  for (const path of Object.keys(state.paths)) {
    const entry = state.paths[path]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
    if (typeof entry.digest !== "string" || typeof entry.sourcePath !== "string") return
  }

  return state
}

export function workspaceSourceSyncStateEquals(left: WorkspaceSourceSyncState | undefined, right: WorkspaceSourceSyncState): boolean {
  if (!left) return false
  return JSON.stringify(canonicalSourceSyncState(left)) === JSON.stringify(canonicalSourceSyncState(right))
}

function canonicalSourceSyncState(state: WorkspaceSourceSyncState): WorkspaceSourceSyncState {
  return {
    configHash: state.configHash,
    mountPath: state.mountPath,
    paths: Object.fromEntries(Object.entries(state.paths).sort(([left], [right]) => left.localeCompare(right))),
    source: state.source,
  }
}
