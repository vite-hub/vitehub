import { posix } from "node:path"

import { WorkspaceError } from "../core/errors.ts"
import { contentStreamToBytes, decodeFile, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath } from "./config.ts"
import { searchText } from "../core/search.ts"
import type { ResolvedWorkspaceSource } from "./config.ts"
import type { ResolvedSourcePath } from "./resolver.ts"
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
  WorkspaceContentStream,
  WorkspaceStat,
  WorkspaceStore,
  WorkspaceDefinition,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceMaterializeSourcesResult,
  WorkspaceSourceMaterializationStatus,
} from "../core/types.ts"

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
  items?: Record<string, LazyMaterializedMetadata>
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

function materializedItemMeta(
  snapshot: SourceSnapshotMetadata | undefined,
  configHash: string,
  path: string,
) {
  if (!snapshot || snapshot.configHash !== configHash) return undefined
  if (snapshot.status !== "ready" && snapshot.status !== "updating" && snapshot.status !== "error") return undefined
  return snapshot.items?.[path]
}

function checkpointItems(items: Record<string, LazyMaterializedMetadata>) {
  return Object.keys(items).length ? items : undefined
}

function contentSize(content: string | Uint8Array) {
  return typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength
}

function sourcePathMatches(path: string, source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined) {
  if (options?.sources?.length && !options.sources.includes(source.key)) return false
  const requested = normalizeWorkspacePath(options?.path || "")
  if (!requested) return true
  return sourceMountIntersectsPath(source, requested)
}

function parentDirectoryPaths(path: string) {
  const parts = normalizeWorkspacePath(path).split("/").filter(Boolean)
  const paths: string[] = []
  for (let index = 1; index < parts.length; index++) paths.push(parts.slice(0, index).join("/"))
  return paths
}

async function removeStaleMaterializedSourceFiles(
  store: WorkspaceStore,
  source: ResolvedWorkspaceSource,
  nextPaths: Set<string>,
  options: { removeUntracked?: boolean } = {},
) {
  const entries = await store.list(source.mountPath, { recursive: true })
  const nextDirectories = new Set([...nextPaths].flatMap(path => parentDirectoryPaths(path)))
  const staleDirectories = new Set<string>()
  for (const entry of entries) {
    if (nextPaths.has(entry.path) || entry.type !== "file") continue
    const file = await store.readFile(entry.path)
    if (options.removeUntracked || file?.metadata?.source === source.key) {
      for (const directory of parentDirectoryPaths(entry.path)) staleDirectories.add(directory)
      await store.rm(entry.path, { force: true })
    }
  }
  for (const entry of entries.filter(entry => entry.type === "directory" && staleDirectories.has(entry.path) && !nextDirectories.has(entry.path)).sort((a, b) => b.path.length - a.path.length)) {
    try {
      await store.rm(entry.path, { force: true })
    }
    catch {}
  }
}

async function* iterateSourceItems(source: ResolvedWorkspaceSource, ctx: SourceContext): AsyncGenerator<WorkspaceSourceItem> {
  if (source.source.getItems) {
    yield* await source.source.getItems(ctx)
    return
  }

  for (const key of await source.source.getKeys(ctx)) {
    yield await source.source.getItem(key, ctx)
  }
}

interface MaterializationEntry {
  content?: string | Uint8Array
  contentStream?: WorkspaceContentStream
  item?: WorkspaceSourceItem
  metadata: LazyMaterializedMetadata
  path: string
  reused?: WorkspaceStat
}

function createMaterializationEntry(
  source: ResolvedWorkspaceSource,
  item: WorkspaceSourceItem,
  upstreamMeta: Record<string, unknown> | undefined,
): MaterializationEntry {
  const path = normalizeWorkspacePath(`${source.mountPath}/${item.path || item.key}`)
  return {
    item,
    metadata: createLazyMaterializedMetadata({
      sourceKey: source.key,
      sourcePath: item.key,
      validate: source.validate,
    }, item, upstreamMeta),
    path,
    ...sourceItemContent(item),
  }
}

function sourceItemContent(item: WorkspaceSourceItem): Pick<MaterializationEntry, "content" | "contentStream"> {
  if (item.contentStream) {
    if (typeof item.content !== "undefined" || typeof item.data !== "undefined") {
      throw new WorkspaceError("[vitehub] Workspace source items cannot define contentStream with content or data.")
    }
    return { contentStream: item.contentStream }
  }
  return { content: item.content ?? (typeof item.data === "undefined" ? "" : JSON.stringify(item.data, null, 2)) }
}

async function* iterateMaterializationEntries(
  source: ResolvedWorkspaceSource,
  ctx: SourceContext,
  store: WorkspaceStore,
  snapshot: SourceSnapshotMetadata | undefined,
  configHash: string,
): AsyncGenerator<MaterializationEntry> {
  if (source.source.getItems) {
    for await (const item of iterateSourceItems(source, ctx)) {
      yield createMaterializationEntry(source, item, await source.source.getMeta?.(item.key, ctx))
    }
    return
  }

  for (const key of await source.source.getKeys(ctx)) {
    const upstreamMeta = await source.source.getMeta?.(key, ctx)
    const path = normalizeWorkspacePath(`${source.mountPath}/${key}`)
    const previous = materializedItemMeta(snapshot, configHash, path)
    if (upstreamMeta && previous?.source === source.key && previous.sourcePath === key && !hasSourceMetaChanged(previous, upstreamMeta)) {
      const stat = await store.stat(path)
      if (stat?.type === "file") {
        yield {
          metadata: previous,
          path,
          reused: stat,
        }
        continue
      }
    }

    yield createMaterializationEntry(source, await source.source.getItem(key, ctx), upstreamMeta)
  }
}

export async function materializeWorkspaceSources(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceMaterializeSourcesOptions = {},
): Promise<WorkspaceMaterializeSourcesResult> {
  const started = Date.now()
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

    const itemMetadata: Record<string, LazyMaterializedMetadata> = existing?.configHash === configHash
      ? { ...(existing.items || {}) }
      : {}
    await writeSourceSnapshotMetadata(store, {
      configHash,
      source: source.key,
      mountPath: source.mountPath,
      status: "updating",
      items: checkpointItems(itemMetadata),
      cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
    })

    let sourceFiles = 0
    let sourceBytes = 0
    try {
      const ctx = createSourceContext(definition, source)
      await source.source.prepare?.(ctx)
      if (source.mountPath) {
        await store.mkdir(source.mountPath, { recursive: true })
      }

      let commit: string | undefined
      const directorySet = new Set<string>(source.mountPath ? [source.mountPath] : [])
      const nextPaths = new Set<string>()
      for await (const entry of iterateMaterializationEntries(source, ctx, store, existing, configHash)) {
        const path = entry.path
        nextPaths.add(path)
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index++) directorySet.add(parts.slice(0, index).join("/"))
        itemMetadata[path] = entry.metadata
        if (entry.reused) {
          commit ||= entry.metadata.ref || entry.metadata.sha
          sourceFiles++
          sourceBytes += entry.reused.size || 0
          await writeSourceSnapshotMetadata(store, {
            configHash,
            source: source.key,
            mountPath: source.mountPath,
            status: "updating",
            commit,
            files: sourceFiles,
            bytes: sourceBytes,
            items: checkpointItems(itemMetadata),
            cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
          })
          continue
        }
        const item = entry.item!
        const metadata = item.metadata || {}
        commit ||= readStringMeta(metadata, "ref") || readStringMeta(metadata, "sha") || entry.metadata.ref || entry.metadata.sha
        const written = await writeMaterializedFile(store, path, {
          path,
          content: entry.content,
          contentStream: entry.contentStream,
          mediaType: item.mediaType,
          metadata: {
            ...metadata,
            ...entry.metadata,
            source: source.key,
          },
        })
        sourceFiles++
        sourceBytes += written.size || 0
        await writeSourceSnapshotMetadata(store, {
          configHash,
          source: source.key,
          mountPath: source.mountPath,
          status: "updating",
          commit,
          files: sourceFiles,
          bytes: sourceBytes,
          items: checkpointItems(itemMetadata),
          cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
        })
      }
      await removeStaleMaterializedSourceFiles(store, source, nextPaths, { removeUntracked: Boolean(source.mountPath) })
      const readyItems = Object.fromEntries([...nextPaths].flatMap((path) => {
        const metadata = itemMetadata[path]
        return metadata ? [[path, metadata] as const] : []
      }))

      const ready: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "ready",
        commit,
        materializedAt: new Date().toISOString(),
        files: sourceFiles,
        bytes: sourceBytes,
        items: readyItems,
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
        files: sourceFiles,
        bytes: sourceBytes,
        items: checkpointItems(itemMetadata),
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
  const content = sourceItemContent(item)
  const nextBase = {
    path: resolution.workspacePath,
    mediaType: item.mediaType,
    metadata: { ...item.metadata, ...metadata },
  }
  const next: WorkspaceFile = {
    ...nextBase,
    content: content.content ?? await contentStreamToBytes(content.contentStream!),
  }
  await store.writeFile(resolution.workspacePath, next)
  await store.setMeta?.(materializedMetaKey(resolution), metadata)
  return next
}

async function writeMaterializedFile(
  store: WorkspaceStore,
  path: string,
  file: {
    path: string
    content?: string | Uint8Array
    contentStream?: WorkspaceContentStream
    mediaType?: string
    metadata?: Record<string, unknown>
  },
): Promise<{ size?: number }> {
  if (file.contentStream) {
    if (store.writeFileStream) {
      return await store.writeFileStream(path, {
        path: file.path,
        content: file.contentStream,
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
    }
    const content = await contentStreamToBytes(file.contentStream)
    await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
    return { size: content.byteLength }
  }

  const content = file.content ?? ""
  await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
  return { size: contentSize(content) }
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
  resolution: Pick<ResolvedSourcePath, "sourceKey" | "sourcePath" | "validate">,
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
  return source.mountPath && workspacePath.startsWith(`${source.mountPath}/`)
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
    .filter(path => sourceMountContainsPath(source, path))
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
