import { createWorkspaceTools } from "../ai.ts"
import { normalizeWorkspacePath } from "../core/path.ts"
import { createMemoryWorkspaceStore } from "../storage/memory.ts"
import { normalizeWorkspaceSource, normalizeWorkspaceSources } from "./config.ts"
import { resolveWorkspacePath } from "./resolver.ts"
import { createWorkspaceSourceView } from "./view.ts"

import type { WorkspaceFacadeToolOptions, ReadonlyWorkspaceFacade, WorkspaceReadToolSet } from "../core/use.ts"
import type {
  ListOptions,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceName,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceSelectedScope,
  WorkspaceSource,
  WorkspaceSourceInput,
  WorkspaceSourceResolutionInvocation,
} from "../core/types.ts"

export interface WorkspaceSourceResolutionOptions {
  invocation: WorkspaceSourceResolutionInvocation
  selectedWorkspaceScope?: WorkspaceSelectedScope
}

export interface WorkspaceSourceResolutionFacade<Name extends WorkspaceName = WorkspaceName> {
  definition: WorkspaceDefinition
  workspace: ReadonlyWorkspaceFacade<Name>
}

export function hasWorkspaceSourceResolvers(definition: Pick<WorkspaceDefinition, "sources"> | undefined): boolean {
  return normalizeWorkspaceSources(definition?.sources).some(source => typeof source.source.resolve === "function")
}

export async function resolveWorkspaceSources(
  definition: WorkspaceDefinition,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceDefinition> {
  if (!hasWorkspaceSourceResolvers(definition)) return definition

  const sources: Record<string, WorkspaceSource> = {}
  for (const [key, source] of Object.entries(definition.sources || {})) {
    const resolved = await resolveWorkspaceSource(definition, key, source, options)
    if (resolved) sources[key] = resolved
  }

  return {
    ...definition,
    sources,
  }
}

export async function createWorkspaceSourceResolutionFacade<Name extends WorkspaceName = WorkspaceName>(
  workspace: ReadonlyWorkspaceFacade<Name>,
  definition: WorkspaceDefinition,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceSourceResolutionFacade<Name>> {
  const resolvedDefinition = await resolveWorkspaceSources(definition, options)
  if (resolvedDefinition === definition) return { definition, workspace }

  const sourceView = createWorkspaceSourceView(resolvedDefinition, createMemoryWorkspaceStore())
  const fs: ReadonlyWorkspaceFacade<Name>["fs"] = {
    async readFile(path, options) {
      if (isSourcePath(resolvedDefinition, path) || await sourceViewHasPath(resolvedDefinition, sourceView, path)) {
        return await sourceView.readFile(path, options as never)
      }
      return await workspace.fs.readFile(path, options as never)
    },
    async stat(path) {
      if (isSourcePath(resolvedDefinition, path) || await sourceViewHasPath(resolvedDefinition, sourceView, path)) {
        return await sourceView.stat(path)
      }
      return await workspace.fs.stat(path)
    },
    async exists(path) {
      if (isSourcePath(resolvedDefinition, path)) return await sourceView.exists(path)
      return await sourceViewHasPath(resolvedDefinition, sourceView, path) || await workspace.fs.exists(path)
    },
    async list(path = "", options = {}) {
      const normalized = normalizeWorkspacePath(path)
      if (normalized && isSourcePath(resolvedDefinition, normalized)) return await sourceView.list(normalized, options)
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.list(path as never, options as ListOptions),
        sourcePathIntersects(resolvedDefinition, normalized) ? sourceView.list(normalized, options) : Promise.resolve([]),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), sourceEntries)
    },
    async glob(pattern, options) {
      const [baseEntries, sourceEntries] = await Promise.all([
        workspace.fs.glob(pattern as never, options),
        sourceView.glob(pattern as never, options),
      ])
      return mergeEntries(filterBaseEntries(resolvedDefinition, baseEntries), sourceEntries)
    },
    async search(query) {
      const scopedToSource = searchQueryTargetsSource(resolvedDefinition, query)
      const [baseHits, sourceHits] = await Promise.all([
        scopedToSource ? Promise.resolve([]) : workspace.fs.search(query),
        sourceView.search(query),
      ])
      return mergeHits(filterBaseHits(resolvedDefinition, baseHits), sourceHits).slice(0, query.limit ?? 100)
    },
    async materializeSources(options = {}) {
      return await sourceView.materializeSources(options)
    },
  }

  const createTools = (options?: WorkspaceFacadeToolOptions) => createWorkspaceTools(fs, {
    broadSearchPaths: options?.broadSearchPaths,
    cwd: options?.cwd,
    maxShellCalls: options?.maxShellCalls,
    maxOutputLength: options?.maxOutputLength,
    operations: {
      list: options?.list,
      materialize: options?.materialize ?? true,
      read: options?.read,
      search: options?.search,
    },
    timeout: options?.timeout,
  })
  const tools = createTools() as WorkspaceReadToolSet
  tools.inspect = createTools as unknown as WorkspaceReadToolSet["inspect"]
  tools.none = (() => ({})) as WorkspaceReadToolSet["none"]

  return {
    definition: resolvedDefinition,
    workspace: {
      fs,
      tools,
    },
  }
}

async function resolveWorkspaceSource(
  definition: WorkspaceDefinition,
  key: string,
  input: WorkspaceSourceInput,
  options: WorkspaceSourceResolutionOptions,
): Promise<WorkspaceSource | undefined> {
  const declared = normalizeWorkspaceSource(key, input)
  const source = declared.source
  if (!source.resolve) return source

  const context = {
    invocation: options.invocation,
    selectedWorkspaceScope: options.selectedWorkspaceScope,
    source: {
      key,
      mountPath: declared.mountPath,
    },
    workspace: {
      name: definition.name,
      rootDir: definition.rootDir,
      sourceRootDir: definition.sourceRootDir,
    },
  }
  const resolved = await source.resolve(context)
  if (!resolved) return undefined

  const resolvedSource = withResolvedSourceRuntimeDefaults(resolved)
  const normalized = normalizeWorkspaceSource(key, resolvedSource)
  if (!selectedScopeIntersectsMount(options.selectedWorkspaceScope, normalized.mountPath)) return undefined

  return {
    ...resolvedSource,
    fingerprint: {
      source: resolvedSource.fingerprint,
      sourceResolution: {
        selectedWorkspaceScope: options.selectedWorkspaceScope
          ? {
              all: options.selectedWorkspaceScope.all,
              paths: options.selectedWorkspaceScope.paths,
              role: options.selectedWorkspaceScope.role,
              scope: options.selectedWorkspaceScope.scope,
            }
          : undefined,
      },
    },
  }
}

function withResolvedSourceRuntimeDefaults(source: WorkspaceSource): WorkspaceSource {
  if (source.materialize || source.mount && typeof source.mount === "object" && source.mount.materialize) {
    return source
  }
  return { ...source, materialize: "lazy" }
}

function isSourcePath(definition: WorkspaceDefinition, path: string): boolean {
  return resolveWorkspacePath(definition, path).type === "source"
}

async function sourceViewHasPath(definition: WorkspaceDefinition, sourceView: ReturnType<typeof createWorkspaceSourceView>, path: string): Promise<boolean> {
  if (!sourcePathIntersects(definition, normalizeWorkspacePath(path))) return false
  try {
    return await sourceView.exists(path)
  }
  catch {
    return false
  }
}

function sourcePathIntersects(definition: WorkspaceDefinition, path: string): boolean {
  return normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize !== "none")
    .some(source => pathIntersects(source.mountPath, path))
}

function searchQueryTargetsSource(definition: WorkspaceDefinition, query: WorkspaceSearchQuery): boolean {
  const paths = query.paths?.length ? query.paths : [query.cwd || ""]
  return paths.every(path => isSourcePath(definition, path))
}

function filterBaseEntries(definition: WorkspaceDefinition, entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter(entry => !isSourcePath(definition, entry.path))
}

function filterBaseHits(definition: WorkspaceDefinition, hits: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  return hits.filter(hit => !isSourcePath(definition, hit.path))
}

function mergeEntries(base: WorkspaceEntry[], source: WorkspaceEntry[]): WorkspaceEntry[] {
  const entries = new Map<string, WorkspaceEntry>()
  for (const entry of base) entries.set(entry.path, entry)
  for (const entry of source) entries.set(entry.path, entry)
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function mergeHits(base: WorkspaceSearchHit[], source: WorkspaceSearchHit[]): WorkspaceSearchHit[] {
  const seen = new Set<string>()
  return [...base, ...source].filter((hit) => {
    const key = `${hit.path}:${hit.line}:${hit.column}:${hit.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function selectedScopeIntersectsMount(scope: WorkspaceSelectedScope | undefined, mountPath: string): boolean {
  if (!scope || scope.all) return true
  return Boolean(scope.paths?.some(path => pathIntersects(path, mountPath)))
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function pathIntersects(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}
