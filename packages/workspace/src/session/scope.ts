import { workspaceError } from "../core/errors.ts"

import type { WorkspaceDiff, WorkspaceEntry, WorkspaceSearchQuery } from "../core/types.ts"

export function isMissingWorkspacePathError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Workspace path does not exist:")
}

export function pathInSessionScope(path: string, paths: string[] | undefined): boolean {
  return !paths || paths.some(scope => path === scope || path.startsWith(`${scope}/`))
}

export function pathIntersectsSessionScope(path: string, paths: string[] | undefined): boolean {
  return pathInSessionScope(path, paths) || Boolean(paths?.some(scope => scope.startsWith(`${path}/`)))
}

export function mkdirPathInSessionScope(path: string, paths: string[] | undefined): boolean {
  return pathInSessionScope(path, paths) || Boolean(paths?.some(scope => scope.startsWith(`${path}/`)))
}

export function assertPathInSessionScope(path: string, paths: string[] | undefined, options: { masked?: boolean, mkdir?: boolean } = {}) {
  const valid = options.mkdir
    ? mkdirPathInSessionScope(path, paths)
    : pathInSessionScope(path, paths)
  if (!valid) {
    throw workspaceError(options.masked
      ? `[vitehub] Workspace file does not exist: ${path}.`
      : `[vitehub] Workspace session path ${path} is outside the session scope.`)
  }
  return path
}

export function assertDiffInsideSessionPaths(diff: WorkspaceDiff, paths: string[] | undefined) {
  if (!paths) return
  const entry = diff.entries.find(entry => !diffEntryInSessionScope(entry, paths))
  if (entry) throw workspaceError(`[vitehub] Workspace session path ${entry.path} is outside the session scope.`)
}

export function filterSessionEntries(entries: WorkspaceEntry[], paths: string[] | undefined): WorkspaceEntry[] {
  if (!paths) return entries
  return entries.filter(entry => pathIntersectsSessionScope(entry.path, paths))
}

export function filterSessionDiff(diff: WorkspaceDiff, paths: string[] | undefined): WorkspaceDiff {
  if (!paths) return diff
  return {
    ...diff,
    entries: diff.entries.filter(entry => diffEntryInSessionScope(entry, paths)),
  }
}

function diffEntryInSessionScope(entry: WorkspaceDiff["entries"][number], paths: string[] | undefined): boolean {
  if (pathInSessionScope(entry.path, paths)) return true
  return entry.after?.type === "directory" && pathIntersectsSessionScope(entry.path, paths)
}

export function scopedSearchQuery(
  query: WorkspaceSearchQuery,
  paths: string[] | undefined,
  normalizePath: (path: string) => string,
): WorkspaceSearchQuery | undefined {
  if (!paths) return query
  const requested = query.paths?.length ? query.paths : [query.cwd || ""]
  const scoped = new Set<string>()

  for (const rawPath of requested) {
    const path = normalizePath(rawPath)
    for (const scope of paths) {
      if (!path || pathInSessionScope(scope, [path])) scoped.add(scope)
      else if (pathInSessionScope(path, [scope])) scoped.add(path)
    }
  }

  if (!scoped.size) return undefined
  return { ...query, cwd: undefined, paths: [...scoped].sort((left, right) => left.localeCompare(right)) }
}
