import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { normalizeWorkspacePath } from "../core/path.ts"

export interface WorkspaceSourceSyncStatePath {
  digest: string
  mountPath?: string
  mediaType?: string
  sourcePath: string
}

export interface WorkspaceSourceSyncState {
  configHash: string
  claims?: Record<string, WorkspaceSourceSyncStatePath[]>
  mountPath: string
  paths: Record<string, WorkspaceSourceSyncStatePath>
  source: string
}

export function sourceSyncMetaKey(sourceKey: string, workspace?: string) {
  return workspace ? `workspace:${workspace}:source:${sourceKey}:sync` : `source:${sourceKey}:sync`
}

/** Identifies the durable metadata record owned by Source Sync. */
export function isWorkspaceSourceSyncMetaKey(key: string): boolean {
  const forms = [key.toLowerCase(), normalizeWorkspacePath(key).toLowerCase()]
  return forms.some(form => /^(?:workspace:.+:)?source:.*:sync$/.test(form))
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
    if (entry.mountPath !== undefined && !hasRuntimeType(entry.mountPath, "string")) return
  }

  if (state.claims !== undefined) {
    if (!state.claims || !hasRuntimeType(state.claims, "object") || Array.isArray(state.claims)) return
    for (const [path, claims] of Object.entries(state.claims)) {
      if (!state.paths[path] || !Array.isArray(claims) || claims.length === 0) return
      const mounts = new Set<string>()
      for (const claim of claims) {
        if (!claim || !hasRuntimeType(claim, "object") || Array.isArray(claim)) return
        if (!hasRuntimeType(claim.digest, "string") || !hasRuntimeType(claim.sourcePath, "string") || !hasRuntimeType(claim.mountPath, "string")) return
        if (mounts.has(claim.mountPath)) return
        mounts.add(claim.mountPath)
      }
    }
  }
  return state
}

/** Legacy records contain one claim per path; new records retain overlapping mounts. */
export function sourceSyncPathClaims(state: WorkspaceSourceSyncState, path: string): WorkspaceSourceSyncStatePath[] {
  return state.claims?.[path] ?? [{ ...state.paths[path]!, mountPath: state.paths[path]!.mountPath ?? state.mountPath }]
}

export function workspaceSourceSyncStateEquals(left: WorkspaceSourceSyncState | undefined, right: WorkspaceSourceSyncState): boolean {
  if (!left) return false
  return JSON.stringify(canonicalSourceSyncState(left)) === JSON.stringify(canonicalSourceSyncState(right))
}

function canonicalSourceSyncState(state: WorkspaceSourceSyncState): WorkspaceSourceSyncState {
  return {
    configHash: state.configHash,
    claims: state.claims,
    mountPath: state.mountPath,
    paths: Object.fromEntries(Object.entries(state.paths).sort(([left], [right]) => left.localeCompare(right))),
    source: state.source,
  }
}
