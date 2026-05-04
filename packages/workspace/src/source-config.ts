import { defu } from "defu"

import { normalizeSafeWorkspacePath } from "./path.ts"

import type {
  SourceContext,
  WorkspaceCacheOptions,
  WorkspaceDefinition,
  WorkspaceMaterializeMode,
  WorkspaceSource,
  WorkspaceValidateMode,
} from "./types.ts"

export interface ResolvedWorkspaceSource {
  key: string
  source: WorkspaceSource
  mountPath: string
  materialize: WorkspaceMaterializeMode
  cache: false | WorkspaceCacheOptions
  validate: WorkspaceValidateMode
  readonly: true
}

export function createSourceContext(definition: WorkspaceDefinition): SourceContext {
  return {
    rootDir: definition.rootDir || process.cwd(),
    workspace: definition.name,
  }
}

export function normalizeWorkspaceSources(sources: WorkspaceDefinition["sources"]): ResolvedWorkspaceSource[] {
  if (!sources) return []

  return Object.entries(sources)
    .map(([key, source]) => normalizeWorkspaceSource(key, source))
    .sort((left, right) => right.mountPath.length - left.mountPath.length || left.key.localeCompare(right.key))
}

export function normalizeWorkspaceSource(key: string, source: WorkspaceSource): ResolvedWorkspaceSource {
  const mount = normalizeSourceMount(source)
  return {
    key,
    source,
    mountPath: normalizeSafeWorkspacePath(mount.path || key),
    materialize: mount.materialize || source.materialize || "build",
    cache: mount.cache ?? normalizeSourceCache(source) ?? false,
    validate: mount.validate ?? source.validate ?? false,
    readonly: true,
  }
}

function normalizeSourceMount(source: WorkspaceSource) {
  if (typeof source.mount === "string") {
    return { path: source.mount }
  }
  return source.mount || {}
}

function normalizeSourceCache(source: Pick<WorkspaceSource, "cache" | "swr">): false | WorkspaceCacheOptions | undefined {
  if (source.cache === false) return false

  const swrCache = normalizeSWR(source.swr)
  if (source.cache) return swrCache ? defu(source.cache, swrCache) : source.cache
  return swrCache
}

function normalizeSWR(swr: boolean | number | undefined): WorkspaceCacheOptions | undefined {
  if (typeof swr === "number") return { swr: true, maxAge: swr }
  if (swr === true) return { swr: true }
}
