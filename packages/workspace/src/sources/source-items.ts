import { workspaceError } from "../core/errors.ts"
import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { sourceMountContainsPath, type ResolvedWorkspaceSource } from "./config.ts"

import type { WorkspaceSourceItem } from "../core/types.ts"

export function normalizeWorkspaceSourceItemPath(
  source: ResolvedWorkspaceSource,
  rawSourcePath: string,
  options: { operation?: string } = {},
) {
  const sourcePath = normalizeSafeWorkspacePath(rawSourcePath, { allowEmpty: false, allowReserved: true })
  const label = options.operation ? `${options.operation} item path` : "source item path"
  if (sourcePath.split("/").some(part => part === ".git" || part === ".vitehub")) {
    throw workspaceError(`[vitehub] Workspace ${label} is reserved: ${rawSourcePath}.`)
  }

  const mountedPath = source.mountPath ? `${source.mountPath}/${sourcePath}` : sourcePath
  const path = normalizeSafeWorkspacePath(mountedPath, { allowEmpty: false })
  if (source.mountPath && !sourceMountContainsPath(source, path)) {
    throw workspaceError(`[vitehub] Workspace ${label} escapes source mount: ${rawSourcePath}.`)
  }

  return { path, sourcePath }
}

export function normalizeSourceItemPath(
  source: ResolvedWorkspaceSource,
  item: WorkspaceSourceItem,
  options: { operation?: string } = {},
) {
  return normalizeWorkspaceSourceItemPath(source, item.path || item.key, options)
}
