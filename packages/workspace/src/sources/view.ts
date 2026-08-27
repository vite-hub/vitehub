import { workspaceError } from "../core/errors.ts"
import { contentStreamToBytes, decodeFile, isExcludedWorkspacePath, matchesAny, normalizeWorkspacePath } from "../core/path.ts"
import { createWorkspaceWritePolicy } from "../core/rules.ts"
import { searchText } from "../core/search.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath, workspaceSourceRequestDescriptorPath } from "./config.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import {
  hasCurrentSourceSnapshot,
  materializeWorkspaceSources,
  readResolvedSourceFile,
  searchMaterializedStore,
  statVirtualSourcePath,
} from "./materialization.ts"
import { resolveWorkspacePath } from "./resolver.ts"
import { readWorkspaceSourceSyncState, sourceSyncMetaKey } from "./sync-state.ts"

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
  WorkspaceSourceItem,
  WorkspaceStat,
  WorkspaceStore,
  WriteFileOptions,
} from "../core/types.ts"

export interface WorkspaceSourceView {
  readFile<TOptions extends ReadFileOptions | undefined = undefined>(path: string, options?: TOptions): Promise<ReadFileResult<TOptions>>
  writeFile(path: string, content: WorkspaceContent, options?: WriteFileOptions): Promise<string>
  assertWritable(path: string): Promise<void>
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
  const sourceContext = createSourceContext(definition, undefined, store)
  const allSources = normalizeWorkspaceSources(definition.sources)
  const sources = allSources.filter(source => !source.requestOnly && source.materialize === "lazy")
  const syncSources = allSources.filter(source => source.sync)
  const descriptorSources = allSources.filter(source => source.requestDescriptor)
  const writePolicy = createWorkspaceWritePolicy(definition)
  const prepareBySource = new Map<string, Promise<void>>()
  const sourceContexts = new Map<string, ReturnType<typeof createSourceContext>>()
  const materializeBySource = new Map<string, Promise<void>>()
  let materializationQueue = Promise.resolve()

  async function materializeSources(options?: import("../core/types.ts").WorkspaceMaterializeSourcesOptions) {
    const pending = materializationQueue.then(async () => await materializeWorkspaceSources(definition, store, options))
    materializationQueue = pending.then(() => undefined, () => undefined)
    return await pending
  }

  function getSourceContext(source: { key: string, mountPath: string }) {
    let context = sourceContexts.get(source.key)
    if (!context) {
      context = createSourceContext(definition, source, store)
      sourceContexts.set(source.key, context)
    }
    return context
  }

  function isLazySourcePath(path: string) {
    return sources.some(source => sourceMountContainsPath(source, path))
  }

  function isSyncSourceMountPath(path: string) {
    return syncSources.some(source => source.mountPath && sourceMountContainsPath(source, path))
  }

  function descriptorSourceForPath(path: string) {
    return descriptorSources.find(source => workspaceSourceRequestDescriptorPath(source.key) === path)
  }

  function descriptorPathEntries(path = "", options: ListOptions = {}): WorkspaceEntry[] {
    if (!descriptorSources.length) return []
    const normalized = normalizeWorkspacePath(path)
    const descriptors = descriptorSources.map(source => workspaceSourceRequestDescriptorPath(source.key))
    if (!normalized) {
      return options.recursive
        ? [
            { path: ".vitehub", type: "directory" },
            { path: ".vitehub/sources", type: "directory" },
            ...descriptors.map(descriptor => ({ path: descriptor, type: "file" as const })),
          ]
        : [{ path: ".vitehub", type: "directory" }]
    }
    if (normalized === ".vitehub") {
      return options.recursive
        ? [
            { path: ".vitehub/sources", type: "directory" },
            ...descriptors.map(descriptor => ({ path: descriptor, type: "file" as const })),
          ]
        : [{ path: ".vitehub/sources", type: "directory" }]
    }
    if (normalized === ".vitehub/sources") {
      return descriptors.map(descriptor => ({ path: descriptor, type: "file" as const }))
    }
    if (descriptors.includes(normalized)) return [{ path: normalized, type: "file" }]
    return []
  }

  function descriptorStat(path: string): WorkspaceStat | undefined {
    if (descriptorSourceForPath(path)) return { path, type: "file" }
    if (descriptorSources.length && (path === ".vitehub" || path === ".vitehub/sources")) return { path, type: "directory" }
  }

  function isDescriptorPath(path: string): boolean {
    return descriptorSources.length > 0 && (path === ".vitehub" || path === ".vitehub/sources" || path.startsWith(".vitehub/sources/"))
  }

  function descriptorContent(source: (typeof descriptorSources)[number]) {
    return JSON.stringify({
      ...source.requestDescriptor,
      sourceKey: source.key,
    }, null, 2)
  }

  function isLiveSource(sourceKey: string) {
    return Boolean(sources.find(item => item.key === sourceKey)?.livePaths)
  }

  function getLazySourcesForPath(path: string) {
    return sources.filter(source => sourceMountIntersectsPath(source, path))
  }

  async function ensurePrepared(sourceKey: string) {
    const source = sources.find(item => item.key === sourceKey)
    if (!source) return
    let pending = prepareBySource.get(sourceKey)
    if (!pending) {
      pending = prepareWorkspaceSource(source.source, getSourceContext(source)).then(() => undefined)
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
    const normalized = normalizeWorkspacePath(path)
    const storeEntries = isDescriptorPath(normalized) ? [] : await store.list(path, options)
    const result = new Map<string, WorkspaceEntry>(storeEntries.map(entry => [entry.path, entry]))
    for (const entry of descriptorPathEntries(path, options)) {
      if (!isExcludedWorkspacePath(entry.path, options.exclude)) result.set(entry.path, entry)
    }
    if (isDescriptorPath(normalized)) {
      return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
    }

    for (const source of getLazySourcesForPath(path)) {
      if (isExcludedWorkspacePath(source.mountPath, options.exclude)) continue
      await ensurePrepared(source.key)
      if (source.livePaths) {
        await pruneLiveSourceStoreEntries(result, source)
        continue
      }
      if (!path && options.recursive && !await hasCurrentSourceSnapshot(store, source)) {
        if ([...result.keys()].some(key => sourceMountContainsPath(source, key))) {
          const allowed = await currentSourceTreePaths(source, getSourceContext(source))
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

    addLiveSourceEntries(result, path, options, sources)

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

    for (const source of descriptorSources) {
      const entryPath = workspaceSourceRequestDescriptorPath(source.key)
      if (query.paths?.length && !requestedPaths.some(path => !normalizeWorkspacePath(path) || sourceMountContainsPath({ mountPath: normalizeWorkspacePath(path) }, entryPath))) {
        continue
      }
      results.push(...searchText(entryPath, descriptorContent(source), { ...query, limit: limit - results.length }))
      if (results.length >= limit) return dedupeHits(results).slice(0, limit)
    }

    for (const source of sources) {
      const paths = sourcePaths.get(source.key)
      if (query.paths?.length && !paths?.length && !query.paths.some(path => !normalizeWorkspacePath(path))) continue
      if (source.livePaths) {
        await ensurePrepared(source.key)
        const liveEntries = liveSourceEntries(source)
          .filter(entry => entry.type === "file")
          .filter(entry => !paths?.length || paths.some(path => !path || entry.path === path || entry.path.startsWith(`${path}/`)))
        for (const entry of liveEntries) {
          const sourcePath = source.livePaths[entry.path]
          if (typeof sourcePath !== "string") continue
          const item = await source.source.getItem(sourcePath, getSourceContext(source))
          const content = await sourceItemContent(item)
          const text = typeof content === "string" ? content : new TextDecoder().decode(content)
          results.push(...searchText(entry.path, text, { ...query, limit: limit - results.length }))
          if (results.length >= limit) break
        }
        if (results.length >= limit) break
        continue
      }
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
      throw workspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
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
    if (typeof file?.metadata?.source === "string" && allSources.some(source => source.key === file.metadata?.source)) return true
    const stat = await store.stat(path)
    if (stat?.type !== "directory") return false
    const entries = await store.list(path, { recursive: true })
    for (const entry of entries) {
      if (entry.type !== "file") continue
      const child = await store.readFile(entry.path)
      if (typeof child?.metadata?.source === "string" && allSources.some(source => source.key === child.metadata?.source)) return true
    }
    return false
  }

  async function isSyncedStatePath(path: string) {
    if (!store.getMeta) return false
    for (const source of syncSources) {
      const state = readWorkspaceSourceSyncState(await store.getMeta(sourceSyncMetaKey(source.key)))
      if (!state) continue
      if (state.paths[path]) return true
      if (Object.keys(state.paths).some(item => item.startsWith(`${path}/`))) return true
    }
    return false
  }

  async function assertWritableResolvedStorePath(path: string, workspacePath: string, type: "source" | "store") {
    assertWritableStorePath(path, workspacePath, type)
    await materializeRootSourceForPath(workspacePath)
    if (isSyncSourceMountPath(workspacePath) || await isSyncedStatePath(workspacePath) || await isSourceBackedStorePath(workspacePath)) {
      throw workspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
  }

  async function assertWritablePath(path: string) {
    if (isDescriptorPath(normalizeWorkspacePath(path))) {
      throw workspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
    const resolution = resolveWorkspacePath(definition, path)
    if (isDescriptorPath(resolution.workspacePath)) {
      throw workspaceError(`[vitehub] Source-backed workspace paths are read-only: ${path}.`)
    }
    await assertWritableResolvedStorePath(path, resolution.workspacePath, resolution.type)
    return resolution
  }

  return {
    async assertWritable(path) {
      await assertWritablePath(path)
    },
    async readFile(path, options) {
      const descriptorSource = descriptorSourceForPath(normalizeWorkspacePath(path))
      if (descriptorSource) return decodeFile(descriptorContent(descriptorSource), options)
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        if (isLiveSource(resolution.sourceKey)) {
          const item = await resolution.source.source.getItem(resolution.sourcePath, getSourceContext(resolution.source))
          return decodeFile(await sourceItemContent(item), options)
        }
        const file = await store.readFile(resolution.workspacePath)
        if (file) return decodeFile(file.content, options)
        await ensureMaterialized(resolution.sourceKey)
        return await readResolvedSourceFile(resolution, store, sourceContext, options)
      }
      await materializeRootSourceForPath(resolution.workspacePath)
      const file = await store.readFile(resolution.workspacePath)
      if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${path}.`)
      return decodeFile(file.content, options)
    },
    async writeFile(path, content, options) {
      const resolution = await assertWritablePath(path)
      const input = await writePolicy.before({
        content,
        mediaType: options?.mediaType,
        metadata: options?.metadata,
        operation: "writeFile",
        path: resolution.workspacePath,
        previous: await previousStat(resolution.workspacePath),
        workspace: definition.name,
      })
      try {
        if (options?.preservePath && input.path !== resolution.workspacePath) {
          throw workspaceError(`[vitehub] Workspace validator cannot rewrite preserved path: ${resolution.workspacePath} -> ${input.path}.`)
        }
        const file = { path: input.path, content: input.content ?? content, mediaType: input.mediaType, metadata: input.metadata }
        if (options?.ifDigest !== undefined) {
          if (!store.writeFileConditional) throw workspaceError("[vitehub] This Workspace Store does not support conditional writes.")
          await store.writeFileConditional(input.path, file, options.ifDigest)
        }
        else await store.writeFile(input.path, file)
        await writePolicy.after(input)
        return input.path
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
      await ensureMaterializedSources(sources.filter(source => !source.livePaths))

      const result = new Map<string, WorkspaceEntry>()
      for (const entry of await store.glob(patterns, options)) {
        result.set(entry.path, entry)
      }
      for (const entry of descriptorPathEntries("", { recursive: true })) {
        if (entry.type === "file" && patterns.some(pattern => matchesAny(entry.path, pattern))) result.set(entry.path, entry)
      }
      for (const source of sources.filter(source => source.livePaths)) {
        await pruneLiveSourceStoreEntries(result, source)
        for (const entry of liveSourceEntries(source)) {
          if (entry.type === "file" && patterns.some(pattern => matchesAny(entry.path, pattern))) result.set(entry.path, entry)
        }
      }

      return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
    },
    async search(query) {
      return await searchWorkspace(query)
    },
    async stat(path) {
      const descriptor = descriptorStat(normalizeWorkspacePath(path))
      if (descriptor) return descriptor
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        if (isLiveSource(resolution.sourceKey)) {
          if (!resolution.workspacePath) return { path: "", type: "directory" }
          const result = liveSourceStat(resolution.source, resolution.workspacePath)
          if (!result) throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
          return result
        }
        const stored = await store.stat(resolution.workspacePath)
        if (stored) return stored
        await ensureMaterialized(resolution.sourceKey)
        const result = await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, getSourceContext(resolution.source))
        if (!result) throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
        return result
      }
      let result = await store.stat(resolution.workspacePath)
      if (!result) {
        if (!resolution.workspacePath && sources.some(source => !source.mountPath && source.livePaths)) {
          return { path: "", type: "directory" }
        }
        await materializeRootSourceForPath(resolution.workspacePath)
        result = await store.stat(resolution.workspacePath)
      }
      if (!result) throw workspaceError(`[vitehub] Workspace path does not exist: ${path}.`)
      return result
    },
    async materializeSources(options) {
      return await materializeSources(options)
    },
    async exists(path) {
      if (descriptorStat(normalizeWorkspacePath(path))) return true
      const resolution = resolveWorkspacePath(definition, path)
      if (resolution.type === "source") {
        await ensurePrepared(resolution.sourceKey)
        if (isLiveSource(resolution.sourceKey)) {
          if (!resolution.workspacePath) return true
          return Boolean(liveSourceStat(resolution.source, resolution.workspacePath))
        }
        if (await store.stat(resolution.workspacePath)) return true
        await ensureMaterialized(resolution.sourceKey)
        return Boolean(await statVirtualSourcePath(resolution.source, resolution.workspacePath, store, getSourceContext(resolution.source)))
      }
      if (await store.stat(resolution.workspacePath)) return true
      if (!resolution.workspacePath && sources.some(source => !source.mountPath && source.livePaths)) return true
      await materializeRootSourceForPath(resolution.workspacePath)
      return Boolean(await store.stat(resolution.workspacePath))
    },
    async mkdir(path, options) {
      const resolution = await assertWritablePath(path)
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
      const resolution = await assertWritablePath(path)
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

  async function pruneLiveSourceStoreEntries(result: Map<string, WorkspaceEntry>, source: ReturnType<typeof normalizeWorkspaceSources>[number]) {
    const allowed = new Set(liveSourceEntries(source).map(entry => entry.path))
    for (const [path, entry] of result) {
      if (!isWithinLiveSourceMount(source, path) || allowed.has(path)) continue
      if (entry.type === "file") {
        const file = await store.readFile(path)
        if (file?.metadata?.source === source.key) result.delete(path)
        continue
      }
      if (!source.mountPath) continue
      if (![...allowed].some(allowedPath => allowedPath.startsWith(`${path}/`))) {
        result.delete(path)
      }
    }
  }
}

function isWithinLiveSourceMount(source: ReturnType<typeof normalizeWorkspaceSources>[number], path: string) {
  return source.mountPath ? sourceMountContainsPath(source, path) : Boolean(path)
}

function liveSourceEntries(source: ReturnType<typeof normalizeWorkspaceSources>[number]): WorkspaceEntry[] {
  const paths = Object.keys(source.livePaths || {})
  const entries = new Map<string, WorkspaceEntry>()
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean)
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/")
      entries.set(directory, { path: directory, type: "directory" })
    }
    entries.set(path, { path, type: "file" })
  }
  return [...entries.values()]
}

async function sourceItemContent(item: WorkspaceSourceItem): Promise<WorkspaceContent> {
  if (item.contentStream) {
    if (typeof item.content !== "undefined" || typeof item.data !== "undefined") {
      throw workspaceError("[vitehub] Workspace source items cannot define contentStream with content or data.")
    }
    return await contentStreamToBytes(item.contentStream)
  }
  return item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2))
}

function addLiveSourceEntries(
  result: Map<string, WorkspaceEntry>,
  path: string,
  options: ListOptions,
  sources: ReturnType<typeof normalizeWorkspaceSources>,
) {
  const normalized = normalizeWorkspacePath(path)
  for (const source of sources.filter(source => source.livePaths)) {
    for (const entry of liveSourceEntries(source)) {
      if (!isListedLiveEntry(entry, normalized, options)) continue
      if (isExcludedWorkspacePath(entry.path, options.exclude)) continue
      result.set(entry.path, entry)
    }
  }
}

function isListedLiveEntry(entry: WorkspaceEntry, path: string, options: ListOptions) {
  if (!path) {
    if (options.recursive) return true
    return !entry.path.includes("/")
  }
  if (entry.path === path) return false
  if (!entry.path.startsWith(`${path}/`)) return false
  if (options.recursive) return true
  return !entry.path.slice(path.length + 1).includes("/")
}

function liveSourceStat(source: ReturnType<typeof normalizeWorkspaceSources>[number], workspacePath: string): WorkspaceStat | undefined {
  return liveSourceEntries(source).find(entry => entry.path === workspacePath)
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
