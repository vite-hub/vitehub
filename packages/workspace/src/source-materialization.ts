import { posix } from "node:path"

import { WorkspaceError } from "./errors.ts"
import { decodeFile, normalizeWorkspacePath, sha256 } from "./path.ts"
import { createSourceContext, normalizeWorkspaceSources } from "./source-config.ts"
import { searchText } from "./search.ts"
import type { ResolvedWorkspaceSource } from "./source-config.ts"
import type { ResolvedSourcePath } from "./source-resolver.ts"
import type {
  ListOptions,
  ReadFileOptions,
  ReadFileResult,
  SourceContext,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceSourceItem,
  WorkspaceStat,
  WorkspaceStore,
  WorkspaceDefinition,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceMaterializeSourcesResult,
  WorkspaceSourceMaterializationStatus,
} from "./types.ts"

export interface LazyMaterializedMetadata {
  source: string
  sourcePath: string
  materializedAt: string
  validatedAt?: string
  etag?: string
  sha?: string
  digest?: string
  ref?: string
}

interface SourceSnapshotMetadata extends WorkspaceSourceMaterializationStatus {
  configHash: string
  cacheMaxAge?: number
}

function sourceSnapshotMetaKey(sourceKey: string) {
  return `source:${sourceKey}:snapshot`
}

function sourceConfigFingerprint(source: ResolvedWorkspaceSource) {
  return {
    cache: source.cache,
    key: source.key,
    materialize: source.materialize,
    mountPath: source.mountPath,
    source: source.source.fingerprint,
  }
}

async function sourceConfigHash(source: ResolvedWorkspaceSource) {
  return await sha256(sourceConfigFingerprint(source))
}

function isSnapshotFresh(meta: SourceSnapshotMetadata | undefined, source: ResolvedWorkspaceSource, configHash: string) {
  if (!meta || meta.status !== "ready" || meta.configHash !== configHash) return false
  if (!source.cache || typeof source.cache.maxAge !== "number") return false
  if (!meta.materializedAt) return false
  return Date.now() - Date.parse(meta.materializedAt) <= source.cache.maxAge * 1000
}

async function readSourceSnapshotMetadata(store: WorkspaceStore, sourceKey: string) {
  return await store.getMeta?.(sourceSnapshotMetaKey(sourceKey)) as SourceSnapshotMetadata | undefined
}

export async function hasFreshSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource) {
  const configHash = await sourceConfigHash(source)
  return isSnapshotFresh(await readSourceSnapshotMetadata(store, source.key), source, configHash)
}

export async function hasCurrentSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource) {
  const configHash = await sourceConfigHash(source)
  const meta = await readSourceSnapshotMetadata(store, source.key)
  return meta?.status === "ready" && meta.configHash === configHash
}

async function writeSourceSnapshotMetadata(store: WorkspaceStore, metadata: SourceSnapshotMetadata) {
  await store.setMeta?.(sourceSnapshotMetaKey(metadata.source), metadata)
}

function contentSize(content: string | Uint8Array) {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength
}

function sourcePathMatches(path: string, source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined) {
  if (options?.sources?.length && !options.sources.includes(source.key)) return false
  const requested = normalizeWorkspacePath(options?.path || "")
  if (!requested) return true
  return requested === source.mountPath || requested.startsWith(`${source.mountPath}/`) || source.mountPath.startsWith(`${requested}/`)
}

export async function materializeWorkspaceSources(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceMaterializeSourcesOptions = {},
): Promise<WorkspaceMaterializeSourcesResult> {
  const started = Date.now()
  const ctx = createSourceContext(definition)
  const sources = normalizeWorkspaceSources(definition.sources).filter(source => source.materialize === "lazy" && sourcePathMatches("", source, options))
  const resultSources: WorkspaceSourceMaterializationStatus[] = []
  let files = 0
  let directories = 0
  let bytes = 0

  for (const source of sources) {
    const configHash = await sourceConfigHash(source)
    const existing = await readSourceSnapshotMetadata(store, source.key)
    if (isSnapshotFresh(existing, source, configHash)) {
      resultSources.push({
        source: source.key,
        mountPath: source.mountPath,
        status: "ready",
        commit: existing?.commit,
        materializedAt: existing?.materializedAt,
        files: existing?.files,
        bytes: existing?.bytes,
      })
      files += existing?.files || 0
      bytes += existing?.bytes || 0
      continue
    }

    await writeSourceSnapshotMetadata(store, {
      configHash,
      source: source.key,
      mountPath: source.mountPath,
      status: "updating",
      cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
    })

    try {
      await source.source.prepare?.(ctx)
      const items = source.source.getItems
        ? await source.source.getItems(ctx)
        : await Promise.all((await source.source.getKeys(ctx)).map(async key => await source.source.getItem(key, ctx)))
      if (source.mountPath) {
        await store.rm(source.mountPath, { recursive: true, force: true })
        await store.mkdir(source.mountPath, { recursive: true })
      }

      let sourceFiles = 0
      let sourceBytes = 0
      let commit: string | undefined
      const directorySet = new Set<string>(source.mountPath ? [source.mountPath] : [])
      for (const item of items) {
        const content = item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2))
        const path = normalizeWorkspacePath(`${source.mountPath}/${item.path || item.key}`)
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index++) directorySet.add(parts.slice(0, index).join("/"))
        const metadata = item.metadata || {}
        commit ||= readStringMeta(metadata, "ref") || readStringMeta(metadata, "sha")
        await store.writeFile(path, {
          path,
          content,
          mediaType: item.mediaType,
          metadata: {
            ...metadata,
            source: source.key,
          },
        })
        sourceFiles++
        sourceBytes += contentSize(content)
      }

      const ready: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "ready",
        commit,
        materializedAt: new Date().toISOString(),
        files: sourceFiles,
        bytes: sourceBytes,
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      await writeSourceSnapshotMetadata(store, ready)
      resultSources.push(ready)
      files += sourceFiles
      bytes += sourceBytes
      directories += directorySet.size
    }
    catch (error) {
      const failed: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      await writeSourceSnapshotMetadata(store, failed)
      resultSources.push(failed)
    }
  }

  return {
    bytes,
    directories,
    durationMs: Date.now() - started,
    files,
    path: normalizeWorkspacePath(options.path || ""),
    sources: resultSources,
  }
}

export async function readResolvedSourceFile<TOptions extends ReadFileOptions | undefined>(
  resolution: ResolvedSourcePath,
  store: WorkspaceStore,
  ctx: SourceContext,
  options?: TOptions,
): Promise<ReadFileResult<TOptions>> {
  const file = await store.readFile(resolution.workspacePath)
  if (!file) throw new WorkspaceError(`[vitehub] Workspace file does not exist: ${resolution.workspacePath}.`)
  return decodeFile(file.content, options)
}

export async function materializeSourceFile(
  resolution: ResolvedSourcePath,
  store: WorkspaceStore,
  ctx: SourceContext,
): Promise<WorkspaceFile> {
  const existing = await store.readFile(resolution.workspacePath)
  const storedMeta = await getStoredMaterializedMetadata(store, resolution)
  if (existing && await shouldReuseMaterializedFile(resolution, storedMeta, ctx)) return existing

  const item = await resolution.source.source.getItem(resolution.sourcePath, ctx)
  const upstreamMeta = await resolution.source.source.getMeta?.(resolution.sourcePath, ctx)
  const metadata = createLazyMaterializedMetadata(resolution, item, upstreamMeta)
  const next: WorkspaceFile = {
    path: resolution.workspacePath,
    content: item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2)),
    mediaType: item.mediaType,
    metadata: { ...item.metadata, ...metadata },
  }
  await store.writeFile(resolution.workspacePath, next)
  await store.setMeta?.(materializedMetaKey(resolution), metadata)
  return next
}

export async function statVirtualSourcePath(
  source: ResolvedWorkspaceSource,
  workspacePath: string,
  store: WorkspaceStore,
  ctx: SourceContext,
): Promise<WorkspaceStat | undefined> {
  const stored = await store.stat(workspacePath)
  if (stored) return stored

  const keys = await source.source.getKeys(ctx)
  const sourcePath = normalizeSourcePath(source, workspacePath)
  if (!sourcePath && keys.length > 0) {
    return { path: source.mountPath, type: "directory" }
  }
  if (keys.includes(sourcePath)) {
    const meta = await source.source.getMeta?.(sourcePath, ctx)
    return {
      path: workspacePath,
      type: "file",
      digest: readDigest(meta),
    }
  }
  if (keys.some(key => key.startsWith(`${sourcePath}/`))) {
    return { path: workspacePath, type: "directory" }
  }
}

export async function listVirtualSourceEntries(
  source: ResolvedWorkspaceSource,
  path: string,
  options: ListOptions,
  store: WorkspaceStore,
  ctx: SourceContext,
) {
  const stored = await store.list(path, options)
  const virtual = new Map<string, WorkspaceEntry>(stored.map(entry => [entry.path, entry]))
  const keys = await source.source.getKeys(ctx)
  const requestPath = path

  for (const key of keys) {
    const fullPath = toMountedSourcePath(source, key)
    if (requestPath === source.mountPath && !key) continue

    if (!requestPath) {
      if (!fullPath.includes("/")) continue
      const firstSegment = fullPath.split("/")[0]
      if (!virtual.has(firstSegment)) virtual.set(firstSegment, { path: firstSegment, type: "directory" })
      if (options.recursive) virtual.set(fullPath, virtual.get(fullPath) || { path: fullPath, type: "file" })
      continue
    }

    if (requestPath === source.mountPath) {
      if (!options.recursive) {
        const relative = key
        const child = relative.split("/")[0]
        const childPath = child ? `${source.mountPath}/${child}` : source.mountPath
        if (!childPath || childPath === source.mountPath) continue
        if (!virtual.has(childPath)) {
          virtual.set(childPath, {
            path: childPath,
            type: relative.includes("/") ? "directory" : "file",
          })
        }
        continue
      }

      virtual.set(fullPath, virtual.get(fullPath) || { path: fullPath, type: "file" })
      addVirtualParents(virtual, source.mountPath, fullPath)
      continue
    }

    if (!fullPath.startsWith(`${requestPath}/`)) continue
    if (!options.recursive) {
      const remainder = fullPath.slice(requestPath.length + 1)
      const child = remainder.split("/")[0]
      const childPath = `${requestPath}/${child}`
      if (!virtual.has(childPath)) {
        virtual.set(childPath, {
          path: childPath,
          type: remainder.includes("/") ? "directory" : "file",
        })
      }
      continue
    }

    virtual.set(fullPath, virtual.get(fullPath) || { path: fullPath, type: "file" })
    addVirtualParents(virtual, requestPath, fullPath)
  }

  return [...virtual.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export async function searchResolvedSource(
  source: ResolvedWorkspaceSource,
  query: WorkspaceSearchQuery,
  store: WorkspaceStore,
  ctx: SourceContext,
): Promise<WorkspaceSearchHit[]> {
  const limit = query.limit ?? 100
  const materializedHits = await searchMaterializedStore(store, {
    ...query,
    paths: query.paths?.length ? query.paths : [source.mountPath],
    limit,
  })
  if (materializedHits.length >= limit) return materializedHits.slice(0, limit)

  if (source.source.search) {
    const hits = await source.source.search({
      ...query,
      paths: toSourceSearchPaths(source, query.paths),
      limit: limit - materializedHits.length,
    }, ctx)
    return dedupeSearchHits([...materializedHits, ...hits.map(hit => ({
      ...hit,
      path: hit.path.startsWith(source.mountPath) ? hit.path : toMountedSourcePath(source, hit.path),
    }))]).slice(0, limit)
  }

  return materializedHits.slice(0, limit)
}

export async function searchMaterializedStore(store: WorkspaceStore, query: WorkspaceSearchQuery): Promise<WorkspaceSearchHit[]> {
  const limit = query.limit ?? 100
  const result: WorkspaceSearchHit[] = []
  const entries = query.paths?.length
    ? (await Promise.all(query.paths.map(async (path) => {
        const [stat, nested] = await Promise.all([
          store.stat(path),
          store.glob(`${path}/**/*`),
        ])
        return [
          ...(stat?.type === "file" ? [stat] : []),
          ...nested,
        ]
      }))).flat()
    : await store.glob("**/*")

  for (const entry of entries) {
    if (entry.type !== "file") continue
    const file = await store.readFile(entry.path)
    if (!file) continue
    const text = typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content)
    result.push(...searchText(entry.path, text, { ...query, limit: limit - result.length }))
    if (result.length >= limit) break
  }

  return result.slice(0, limit)
}

function materializedMetaKey(resolution: ResolvedSourcePath) {
  return `source:${resolution.sourceKey}:${resolution.workspacePath}:materialized`
}

async function getStoredMaterializedMetadata(store: WorkspaceStore, resolution: ResolvedSourcePath) {
  return await store.getMeta?.(materializedMetaKey(resolution)) as LazyMaterializedMetadata | undefined
}

async function shouldReuseMaterializedFile(
  resolution: ResolvedSourcePath,
  metadata: LazyMaterializedMetadata | undefined,
  ctx: SourceContext,
): Promise<boolean> {
  if (!metadata) return false
  if (resolution.validate === false) return true

  if (resolution.source.source.getMeta) {
    const upstream = await resolution.source.source.getMeta(resolution.sourcePath, ctx)
    if (!upstream) return isCacheFresh(metadata, resolution.cache)
    return !hasSourceMetaChanged(metadata, upstream)
  }

  return isCacheFresh(metadata, resolution.cache)
}

function createLazyMaterializedMetadata(
  resolution: ResolvedSourcePath,
  item: WorkspaceSourceItem,
  upstreamMeta: Record<string, unknown> | undefined,
): LazyMaterializedMetadata {
  const now = new Date().toISOString()
  return {
    source: resolution.sourceKey,
    sourcePath: resolution.sourcePath,
    materializedAt: now,
    validatedAt: resolution.validate === "request" ? now : undefined,
    etag: readStringMeta(upstreamMeta, "etag"),
    sha: readStringMeta(upstreamMeta, "sha"),
    digest: readStringMeta(upstreamMeta, "digest") || readStringMeta(item.metadata, "digest"),
    ref: readStringMeta(upstreamMeta, "ref"),
  }
}

function hasSourceMetaChanged(current: LazyMaterializedMetadata, upstreamMeta: Record<string, unknown>) {
  const next = {
    etag: readStringMeta(upstreamMeta, "etag"),
    sha: readStringMeta(upstreamMeta, "sha"),
    digest: readStringMeta(upstreamMeta, "digest"),
    ref: readStringMeta(upstreamMeta, "ref"),
  }
  return current.etag !== next.etag
    || current.sha !== next.sha
    || current.digest !== next.digest
    || current.ref !== next.ref
}

function isCacheFresh(metadata: LazyMaterializedMetadata, cache: ResolvedSourcePath["cache"]) {
  if (!cache || typeof cache.maxAge !== "number") return false
  const createdAt = Date.parse(metadata.validatedAt || metadata.materializedAt)
  if (!createdAt) return false
  return Date.now() - createdAt <= cache.maxAge * 1000
}

function normalizeSourcePath(source: ResolvedWorkspaceSource, workspacePath: string) {
  if (workspacePath === source.mountPath) return ""
  return workspacePath.startsWith(`${source.mountPath}/`)
    ? normalizeWorkspacePath(workspacePath.slice(source.mountPath.length + 1))
    : normalizeWorkspacePath(workspacePath)
}

function readStringMeta(meta: Record<string, unknown> | undefined, key: string) {
  return typeof meta?.[key] === "string" ? meta[key] as string : undefined
}

function readDigest(meta: Record<string, unknown> | undefined) {
  return readStringMeta(meta, "digest") || readStringMeta(meta, "sha")
}

function toSourceSearchPaths(source: ResolvedWorkspaceSource, paths: string[] | undefined) {
  if (!paths?.length) return undefined
  return paths
    .filter(path => path === source.mountPath || path.startsWith(`${source.mountPath}/`))
    .map(path => normalizeSourcePath(source, path))
}

function toMountedSourcePath(source: ResolvedWorkspaceSource, key: string) {
  return normalizeWorkspacePath(posix.join(source.mountPath, key))
}

function addVirtualParents(entries: Map<string, WorkspaceStat>, basePath: string, path: string) {
  const relative = path.slice(basePath.length).replace(/^\/+/, "")
  const parts = relative.split("/").filter(Boolean)
  for (let index = 1; index < parts.length; index++) {
    const directory = `${basePath}/${parts.slice(0, index).join("/")}`
    if (!entries.has(directory)) entries.set(directory, { path: directory, type: "directory" })
  }
}

function dedupeSearchHits(hits: WorkspaceSearchHit[]) {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const key = `${hit.path}:${hit.line}:${hit.column}:${hit.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
