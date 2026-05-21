import { normalizeSafeWorkspacePath, normalizeWorkspacePath } from "./path.ts"
import { normalizeWorkspaceSources, sourceMountContainsPath, type ResolvedWorkspaceSource } from "./source-config.ts"

import type { WorkspaceDefinition, WorkspaceSearchQuery } from "./types.ts"

export interface ResolvedStorePath {
  type: "store"
  workspacePath: string
  readonly: false
}

export interface ResolvedSourcePath {
  type: "source"
  sourceKey: string
  source: ResolvedWorkspaceSource
  workspacePath: string
  sourcePath: string
  materialize: ResolvedWorkspaceSource["materialize"]
  cache: ResolvedWorkspaceSource["cache"]
  validate: ResolvedWorkspaceSource["validate"]
  readonly: true
}

export type ResolvedWorkspacePath = ResolvedStorePath | ResolvedSourcePath

export function resolveWorkspacePath(definition: WorkspaceDefinition, path: string): ResolvedWorkspacePath {
  const workspacePath = normalizeSafeWorkspacePath(path, { allowEmpty: true })
  const sources = normalizeWorkspaceSources(definition.sources)

  for (const source of sources) {
    if (workspacePath === source.mountPath) {
      return createSourceResolution(source, workspacePath, "")
    }
    if (sourceMountContainsPath(source, workspacePath)) {
      return createSourceResolution(source, workspacePath, source.mountPath ? workspacePath.slice(source.mountPath.length + 1) : workspacePath)
    }
  }

  return {
    type: "store",
    workspacePath,
    readonly: false,
  }
}

export function resolveWorkspaceSearchPaths(definition: WorkspaceDefinition, query: WorkspaceSearchQuery): ResolvedWorkspacePath[] {
  const rawPaths = query.paths?.length ? query.paths : [query.cwd || ""]
  return rawPaths
    .map(path => normalizeWorkspacePath(path))
    .filter((path, index, list) => list.indexOf(path) === index)
    .map(path => resolveWorkspacePath(definition, path))
}

function createSourceResolution(source: ResolvedWorkspaceSource, workspacePath: string, sourcePath: string): ResolvedSourcePath {
  return {
    type: "source",
    sourceKey: source.key,
    source,
    workspacePath,
    sourcePath: normalizeWorkspacePath(sourcePath),
    materialize: source.materialize,
    cache: source.cache,
    validate: source.validate,
    readonly: true,
  }
}
