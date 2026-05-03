import { WorkspaceError } from "./errors.ts"
import { decodeFile, matchesAny, normalizeWorkspacePath, resolveGlobPatterns } from "./path.ts"
import { createSourceContext, normalizeWorkspaceSources } from "./source-config.ts"
import {
  dedupeSearchHits,
  listVirtualSourceEntries,
  readResolvedSourceFile,
  searchMaterializedStore,
  searchResolvedSource,
  statVirtualSourcePath,
} from "./source-materialization.ts"
import { resolveWorkspacePath } from "./source-resolver.ts"

import type {
  GlobOptions,
  ListOptions,
  MkdirOptions,
  ReadFileOptions,
  ReadFileResult,
  RmOptions,
  WorkspaceContent,
  WorkspaceDefinition,
  WorkspaceEntry,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceStat,
  WorkspaceStore,
  WriteFileOptions,
} from "./types.ts"

export interface WorkspaceSourceView {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
  list(path?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  stat(path: string): Promise<WorkspaceStat>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
}

export function createWorkspaceSourceView(definition: WorkspaceDefinition, store: WorkspaceStore): WorkspaceSourceView {
  const sourceContext = createSourceContext(definition)
  const sources = normalizeWorkspaceSources(definition.sources).filter(source => source.materialize === "lazy")
  const prepareBySource = new Map<string, Promise<void>>()

  function isLazySourcePath(path: string) {
    return sources.some(source => path === source.mountPath || path.startsWith(`${source.mountPath}/`))
  }

  function getLazySourcesForPath(path: string) {
    return sources.filter((source) => {
      if (!path) return true
      return path === source.mountPath
        || path.startsWith(`${source.mountPath}/`)
        || source.mountPath.startsWith(`${path}/`)
    })
  }

  async function ensurePrepared(sourceKey: string) {
    const source = sources.find(item => item.key === sourceKey)?.source
    if (!source?.prepare) return
    let pending = prepareBySource.get(sourceKey)
    if (!pending) {
      pending = source.prepare(sourceContext)
      prepareBySource.set(sourceKey, pending)
    }
    await pending
  }

  async function ensurePreparedSources(items = sources) {
    await Promise.all(items.map(async source => await ensurePrepared(source.key)))
  }

  async function listSourceAware(path = "", options: ListOptions = {}) {
    const storeEntries = await store.list(path, options)
    const result = new Map<string, WorkspaceEntry>(storeEntries.map(entry => [entry.path, entry]))

    for (const source of getLazySourcesForPath(path)) {
      await ensurePrepared(source.key)
      const entries = await listVirtualSourceEntries(source, path, options, store, sourceContext)
      for (const entry of entries) {
        if (!result.has(entry.path)) result.set(entry.path, entry)
      }
    }

    return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  async function searchWorkspace(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]> {
    const limit = query.limit ?? 100
    const storePaths: string[] = []
    const sourcePaths = new Map<string, string[]>()
    const requestedPaths = query.paths?.length ? query.paths : [query.cwd || ""]

    for (const requestedPath of requestedPaths) {
      const normalized = normalizeWorkspacePath(requestedPath)
      const resolution = resolveWorkspacePath(definition, normalized)
      if (resolution.type === "store") {
        storePaths.push(resolution.workspacePath)
        continue
      }
      const list = sourcePaths.get(resolution.sourceKey) || []
      list.push(resolution.workspacePath)
      sourcePaths.set(resolution.sourceKey, list)
    }

    const results: WorkspaceSearchHit[] = await searchMaterializedStore(store, {
      ...query,
      paths: storePaths.filter(Boolean).length ? storePaths.filter(Boolean) : undefined,
      limit,
    })

    if (query.paths?.length && !storePaths.filter(Boolean).length) {
      results.length = 0
    }

    for (const source of sources) {
      const paths = sourcePaths.get(source.key)
      if (query.paths?.length && !paths?.length) continue
      await ensurePrepared(source.key)
      const hits = await searchResolvedSource(source, {
        ...query,
        paths,
        limit: limit - results.length,
      }, store, sourceContext)
      results.push(...hits)
      if (results.length >= limit) break
    }

    return dedupeSearchHits(results).slice(0, limit)
  }

  function assertWritableStorePath(path: string, workspacePath: string, type: "source" | "store") {
    if (type === "source" || isLazySourcePath(workspacePath)) {
      throw new WorkspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
  }

  return {
    async readFile(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        return await readResolvedSourceFile(resolution, store, sourceContext, options)
      }
      const file = await store.readFile(resolution.workspacePath)
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path, content, options) {
      const resolution = resolveWorkspacePath(definition, path)
      assertWritableStorePath(path, resolution.workspacePath, resolution.type)
      await store.writeFile(resolution.workspacePath, { path: resolution.workspacePath, content, mediaType: options?.mediaType })
    },
    async list(path, options) {
      return await listSourceAware(path || "", options || {})
    },
    async glob(pattern, options) {
      const patterns = resolveGlobPatterns(pattern, options)
      const result = new Map<string, WorkspaceEntry>()
      for (const entry of await store.glob(pattern, options)) {
        result.set(entry.path, entry)
      }

      await ensurePreparedSources()
      for (const source of sources) {
        const keys = await source.source.getKeys(sourceContext)
        for (const key of keys) {
          const path = normalizeWorkspacePath(`${source.mountPath}/${key}`)
          if (!patterns.some(item => matchesAny(path, item))) continue
          if (!result.has(path)) result.set(path, { path, type: "file" })
        }
      }

      return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
    },
    async search(query) {
      return await searchWorkspace(query)
    },
    async stat(path) {
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        const result = await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, sourceContext)
        if (!result) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
        return result
      }
      const result = await store.stat(resolution.workspacePath)
      if (!result) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      return result
    },
    async exists(path) {
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        return Boolean(await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, sourceContext))
      }
      return Boolean(await store.stat(resolution.workspacePath))
    },
    async mkdir(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      assertWritableStorePath(path, resolution.workspacePath, resolution.type)
      await store.mkdir(resolution.workspacePath, options)
    },
    async rm(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      assertWritableStorePath(path, resolution.workspacePath, resolution.type)
      await store.rm(resolution.workspacePath, options)
    },
  }
}
