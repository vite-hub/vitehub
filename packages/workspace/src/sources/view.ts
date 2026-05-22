import { WorkspaceError } from "../core/errors.ts"
import { decodeFile, normalizeWorkspacePath } from "../core/path.ts"
import { createWorkspaceWritePolicy } from "../core/rules.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath } from "./config.ts"
import {
  hasCurrentSourceSnapshot,
  materializeWorkspaceSources,
  readResolvedSourceFile,
  searchMaterializedStore,
  statVirtualSourcePath,
} from "./materialization.ts"
import { resolveWorkspacePath } from "./resolver.ts"

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
} from "../core/types.ts"

export interface WorkspaceSourceView {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<void>
  list(path?: string, options?: ListOptions): Promise<WorkspaceEntry[]>
  glob(pattern: string | string[], options?: GlobOptions): Promise<WorkspaceEntry[]>
  search(query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]>
  stat(path: string): Promise<WorkspaceStat>
  exists(path: string): Promise<boolean>
  materializeSources(options?: import("../core/types.ts").WorkspaceMaterializeSourcesOptions): Promise<import("../core/types.ts").WorkspaceMaterializeSourcesResult>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rm(path: string, options?: RmOptions): Promise<void>
}

export function createWorkspaceSourceView(definition: WorkspaceDefinition, store: WorkspaceStore): WorkspaceSourceView {
  const sourceContext = createSourceContext(definition)
  const sources = normalizeWorkspaceSources(definition.sources).filter(source => source.materialize === "lazy")
  const writePolicy = createWorkspaceWritePolicy(definition)
  const prepareBySource = new Map<string, Promise<void>>()
  const materializeBySource = new Map<string, Promise<void>>()

  function isLazySourcePath(path: string) {
    return sources.some(source => sourceMountContainsPath(source, path))
  }

  function getLazySourcesForPath(path: string) {
    return sources.filter(source => sourceMountIntersectsPath(source, path))
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

  async function ensureMaterialized(sourceKey: string) {
    let pending = materializeBySource.get(sourceKey)
    if (!pending) {
      pending = materializeWorkspaceSources(definition, store, { sources: [sourceKey] }).then(() => undefined)
      materializeBySource.set(sourceKey, pending)
    }
    await pending
  }

  async function ensureMaterializedSources(items = sources) {
    await Promise.all(items.map(async source => await ensureMaterialized(source.key)))
  }

  async function listSourceAware(path = "", options: ListOptions = {}) {
    const storeEntries = await store.list(path, options)
    const result = new Map<string, WorkspaceEntry>(storeEntries.map(entry => [entry.path, entry]))

    for (const source of getLazySourcesForPath(path)) {
      await ensurePrepared(source.key)
      if (!path && options.recursive && !await hasCurrentSourceSnapshot(store, source)) {
        if ([...result.keys()].some(key => sourceMountContainsPath(source, key))) {
          const allowed = await currentSourceTreePaths(source, sourceContext)
          for (const key of result.keys()) {
            if (sourceMountContainsPath(source, key) && !allowed.has(key)) result.delete(key)
          }
          result.set(source.mountPath, { path: source.mountPath, type: "directory" })
          continue
        }
        for (const key of result.keys()) {
          if (sourceMountContainsPath(source, key)) result.delete(key)
        }
        result.set(source.mountPath, { path: source.mountPath, type: "directory" })
        continue
      }
      if (sourceMountContainsPath(source, path) || !source.mountPath && path) {
        await ensureMaterialized(source.key)
        for (const entry of await store.list(path, options)) result.set(entry.path, entry)
      }
      else if (!path && !result.has(source.mountPath)) {
        result.set(source.mountPath, { path: source.mountPath, type: "directory" })
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
      await ensureMaterialized(source.key)
      results.push(...await searchMaterializedStore(store, {
        ...query,
        paths,
        limit: limit - results.length,
      }))
      if (results.length >= limit) break
    }

    return dedupeHits(results).slice(0, limit)
  }

  function assertWritableStorePath(path: string, workspacePath: string, type: "source" | "store") {
    if (type === "source" || isLazySourcePath(workspacePath)) {
      throw new WorkspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
  }

  async function previousStat(path: string) {
    return await store.stat(path)
  }

  async function materializeRootSourceForPath(path: string) {
    for (const source of sources.filter(source => !source.mountPath)) {
      await ensurePrepared(source.key)
      await ensureMaterialized(source.key)
      const file = await store.readFile(path)
      if (file?.metadata?.source === source.key) return source
    }
  }

  async function isSourceBackedStorePath(path: string) {
    const file = await store.readFile(path)
    if (typeof file?.metadata?.source === "string" && sources.some(source => source.key === file.metadata?.source)) return true
    const stat = await store.stat(path)
    if (stat?.type !== "directory") return false
    const entries = await store.list(path, { recursive: true })
    for (const entry of entries) {
      if (entry.type !== "file") continue
      const child = await store.readFile(entry.path)
      if (typeof child?.metadata?.source === "string" && sources.some(source => source.key === child.metadata?.source)) return true
    }
    return false
  }

  async function assertWritableResolvedStorePath(path: string, workspacePath: string, type: "source" | "store") {
    assertWritableStorePath(path, workspacePath, type)
    await materializeRootSourceForPath(workspacePath)
    if (await isSourceBackedStorePath(workspacePath)) {
      throw new WorkspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
  }

  return {
    async readFile(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        await ensureMaterialized(resolution.sourceKey)
        return await readResolvedSourceFile(resolution, store, sourceContext, options)
      }
      await materializeRootSourceForPath(resolution.workspacePath)
      const file = await store.readFile(resolution.workspacePath)
      if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path, content, options) {
      const resolution = resolveWorkspacePath(definition, path)
      await assertWritableResolvedStorePath(path, resolution.workspacePath, resolution.type)
      const input = await writePolicy.before({
        content,
        mediaType: options?.mediaType,
        operation: "writeFile",
        path: resolution.workspacePath,
        previous: await previousStat(resolution.workspacePath),
        workspace: definition.name,
      })
      try {
        await store.writeFile(input.path, { path: input.path, content: input.content ?? content, mediaType: input.mediaType })
        await writePolicy.after(input)
      }
      catch (error) {
        await writePolicy.error(input, error)
        throw error
      }
    },
    async list(path, options) {
      return await listSourceAware(path || "", options || {})
    },
    async glob(pattern, options) {
      const patterns = Array.isArray(pattern) ? pattern : [pattern]
      await ensurePreparedSources()
      await ensureMaterializedSources()

      const result = new Map<string, WorkspaceEntry>()
      for (const entry of await store.glob(patterns, options)) {
        result.set(entry.path, entry)
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
        await ensureMaterialized(resolution.sourceKey)
        const result = await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, sourceContext)
        if (!result) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
        return result
      }
      let result = await store.stat(resolution.workspacePath)
      if (!result) {
        await materializeRootSourceForPath(resolution.workspacePath)
        result = await store.stat(resolution.workspacePath)
      }
      if (!result) throw new WorkspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      return result
    },
    async materializeSources(options) {
      return await materializeWorkspaceSources(definition, store, options)
    },
    async exists(path) {
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        await ensureMaterialized(resolution.sourceKey)
        return Boolean(await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, sourceContext))
      }
      if (await store.stat(resolution.workspacePath)) return true
      await materializeRootSourceForPath(resolution.workspacePath)
      return Boolean(await store.stat(resolution.workspacePath))
    },
    async mkdir(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      await assertWritableResolvedStorePath(path, resolution.workspacePath, resolution.type)
      const input = await writePolicy.before({
        operation: "mkdir",
        path: resolution.workspacePath,
        previous: await previousStat(resolution.workspacePath),
        workspace: definition.name,
      })
      try {
        await store.mkdir(input.path, options)
        await writePolicy.after(input)
      }
      catch (error) {
        await writePolicy.error(input, error)
        throw error
      }
    },
    async rm(path, options) {
      const resolution = resolveWorkspacePath(definition, path)
      await assertWritableResolvedStorePath(path, resolution.workspacePath, resolution.type)
      const input = await writePolicy.before({
        operation: "rm",
        path: resolution.workspacePath,
        previous: await previousStat(resolution.workspacePath),
        workspace: definition.name,
      })
      try {
        await store.rm(input.path, options)
        await writePolicy.after(input)
      }
      catch (error) {
        await writePolicy.error(input, error)
        throw error
      }
    },
  }
}

async function currentSourceTreePaths(source: ReturnType<typeof normalizeWorkspaceSources>[number], sourceContext: ReturnType<typeof createSourceContext>) {
  const allowed = new Set<string>([source.mountPath])
  const keys = await source.source.getKeys(sourceContext)
  for (const key of keys) {
    const path = `${source.mountPath}/${key}`.replace(/\/+/g, "/")
    const parts = path.split("/")
    for (let index = 1; index <= parts.length; index++) {
      allowed.add(parts.slice(0, index).join("/"))
    }
  }
  return allowed
}

function dedupeHits(hits: WorkspaceSearchHit[]) {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.path}:${hit.line}:${hit.column}:${hit.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
