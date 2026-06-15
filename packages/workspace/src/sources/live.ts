import type { WorkspaceSource } from "../core/types.ts"

const liveSourcePaths = new WeakMap<WorkspaceSource, Record<string, string>>()

export function markLiveWorkspaceSource(source: WorkspaceSource, paths: Record<string, string>): WorkspaceSource {
  liveSourcePaths.set(source, paths)
  return source
}

export function getLiveWorkspaceSourcePaths(source: WorkspaceSource): Record<string, string> | undefined {
  return liveSourcePaths.get(source)
}
