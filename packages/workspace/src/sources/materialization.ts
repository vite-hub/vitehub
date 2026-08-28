import { posix } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { workspaceError } from "../core/errors.ts"
import { contentStreamChunks, contentStreamToBytes, decodeFile, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath } from "./config.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import { normalizeSourceItemPath, normalizeWorkspaceSourceItemPath } from "./source-items.ts"
import { searchText } from "../core/search.ts"
import type { ResolvedWorkspaceSource } from "./config.ts"
import type { ResolvedSourcePath } from "./resolver.ts"
import type {
  ReadFileOptions,
  ReadFileResult,
  SourceContext,
  WorkspaceSearchHit,
  WorkspaceSearchQuery,
  WorkspaceSourceItem,
  WorkspaceContentStream,
  WorkspaceStat,
  WorkspaceStore,
  WorkspaceDefinition,
  WorkspaceMaterializeSourcesOptions,
  WorkspaceMaterializeSourcesProgressEvent,
  WorkspaceMaterializeSourcesResult,
  WorkspaceSourceMaterializationCounts,
  WorkspaceSourceMaterializationPathResult,
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
  materializedAttributes?: true
  materializedBytes?: number
  materializedMediaType?: string
  materializedMetadata?: Record<string, unknown>
}

interface SourceSnapshotMetadata extends Omit<WorkspaceSourceMaterializationStatus, "cacheStatus" | "counts" | "durationMs" | "paths" | "provider"> {
  configHash: string
  cacheMaxAge?: number
  items?: Record<string, LazyMaterializedMetadata>
}

export interface MaterializationControl {
  isCurrent(): boolean
  mutate<T>(operation: () => Promise<T>): Promise<T>
  checkpoint<T>(operation: () => Promise<T>): Promise<T>
}

export function sourceSnapshotMetaKey(sourceKey: string) {
  return `source:${sourceKey}:snapshot`
}

type SourceConfiguration = Pick<ResolvedWorkspaceSource, "cache" | "key" | "materialize" | "mountPath" | "source">

function sourceConfigFingerprint(source: SourceConfiguration) {
  return {
    cache: source.cache,
    key: source.key,
    materialize: source.materialize,
    mountPath: source.mountPath,
    source: source.source.fingerprint,
  }
}

async function sourceConfigHash(source: SourceConfiguration) {
  return await sha256(sourceConfigFingerprint(source))
}

function isSnapshotFresh(meta: SourceSnapshotMetadata | undefined, source: ResolvedWorkspaceSource, configHash: string) {
  if (!meta || meta.status !== "ready" || meta.configHash !== configHash) return false
  if (!source.cache) return false
  const maxAge = source.cache.maxAge ?? Number.NaN
  if (!Number.isFinite(maxAge)) return false
  if (!meta.materializedAt) return false
  return Date.now() - Date.parse(meta.materializedAt) <= maxAge * 1000
}

async function readSourceSnapshotMetadata(store: Pick<WorkspaceStore, "getMeta">, sourceKey: string) {
  // SAFETY: This private metadata key is written exclusively by writeSourceSnapshotMetadata below.
  return await store.getMeta?.(sourceSnapshotMetaKey(sourceKey)) as SourceSnapshotMetadata | undefined
}

export async function hasCurrentSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource) {
  const configHash = await sourceConfigHash(source)
  const meta = await readSourceSnapshotMetadata(store, source.key)
  return meta?.status === "ready" && meta.configHash === configHash
}

export async function hasFreshSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource) {
  const configHash = await sourceConfigHash(source)
  return isSnapshotFresh(await readSourceSnapshotMetadata(store, source.key), source, configHash)
}

export async function readCurrentSourceSnapshot(store: Pick<WorkspaceStore, "getMeta">, source: SourceConfiguration) {
  const configHash = await sourceConfigHash(source)
  const snapshot = await readSourceSnapshotMetadata(store, source.key)
  return snapshot?.configHash === configHash ? snapshot : undefined
}

export async function sourceSnapshotOwnsAnyPath(store: WorkspaceStore, sourceKey: string, paths: Iterable<string>): Promise<boolean | undefined> {
  const meta = await readSourceSnapshotMetadata(store, sourceKey)
  if (!meta || meta.status !== "ready") return undefined
  const ownedPaths = new Set(Object.keys(meta.items || {}))
  return [...paths].some(path => ownedPaths.has(normalizeWorkspacePath(path)))
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
  return content instanceof Uint8Array ? content.byteLength : new TextEncoder().encode(content).byteLength
}

function normalizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeMetadataValue)
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, normalizeMetadataValue(entry)]))
}

function observableFileMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata || {})
    .filter(([key, value]) => key !== "materializedAt" && key !== "validatedAt" && value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, normalizeMetadataValue(value)]))
}

function fileAttributesEqual(
  previous: { mediaType?: string, metadata?: Record<string, unknown> },
  previousSnapshot: LazyMaterializedMetadata | undefined,
  mediaType: string | undefined,
  metadata: Record<string, unknown>,
) {
  if (previousSnapshot?.materializedAttributes) {
    return previousSnapshot.materializedMediaType === mediaType
      && isDeepStrictEqual(observableFileMetadata(previousSnapshot.materializedMetadata), observableFileMetadata(metadata))
  }
  return (previous.mediaType === undefined || previous.mediaType === mediaType)
    && (previous.metadata === undefined || isDeepStrictEqual(observableFileMetadata(previous.metadata), observableFileMetadata(metadata)))
}

function sourcePathMatches(path: string, source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined) {
  if (options?.sources?.length && !options.sources.includes(source.key)) return false
  const requested = normalizeWorkspacePath(options?.path || "")
  if (!requested) return true
  return sourceMountIntersectsPath(source, requested)
}

function pathContains(container: string, path: string): boolean {
  return !container || path === container || path.startsWith(`${container}/`)
}

function materializationPathMatches(path: string, options: WorkspaceMaterializeSourcesOptions | undefined) {
  const requested = normalizeWorkspacePath(options?.path || "")
  return pathContains(requested, path)
}

export function materializesCompleteSource(source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined) {
  const requested = normalizeWorkspacePath(options?.path || "")
  return !requested || Boolean(source.mountPath && pathContains(requested, source.mountPath))
}

function shouldMaterializeSource(source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined) {
  if (source.requestOnly || !sourcePathMatches("", source, options)) return false
  if (source.materialize === "lazy" || source.materialize === "startup") return true
  return source.materialize === "build" && Boolean(options?.path)
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : workspaceError("[vitehub] Workspace source materialization aborted.")
}

async function reportMaterializationProgress(
  options: WorkspaceMaterializeSourcesOptions | undefined,
  source: ResolvedWorkspaceSource,
  event: Omit<WorkspaceMaterializeSourcesProgressEvent, "mountPath" | "path" | "source">,
) {
  await options?.onProgress?.({
    ...event,
    mountPath: source.mountPath,
    path: normalizeWorkspacePath(options?.path || ""),
    provider: source.source.name,
    source: source.key,
  })
}

function emptyMaterializationCounts(): WorkspaceSourceMaterializationCounts {
  return { added: 0, removed: 0, unchanged: 0, updated: 0 }
}

function materializationCacheStatus(source: ResolvedWorkspaceSource, complete: boolean, hit: boolean) {
  if (!complete) return "bypassed" as const
  if (!source.cache) return "disabled" as const
  return hit ? "hit" as const : "miss" as const
}

function materializationPaths(options: WorkspaceMaterializeSourcesOptions | undefined, paths: WorkspaceSourceMaterializationPathResult[]) {
  return options?.details === "paths"
    ? paths.slice().sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status))
    : undefined
}

function contentEquals(left: string | Uint8Array, right: string | Uint8Array) {
  const leftBytes = left instanceof Uint8Array ? left : new TextEncoder().encode(left)
  const rightBytes = right instanceof Uint8Array ? right : new TextEncoder().encode(right)
  return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index])
}

function shouldReportMaterializationUpdate(lastReportedAt: number, files: number) {
  return files === 1 || files % 25 === 0 || Date.now() - lastReportedAt >= 1_000
}

function looksLikeConcreteFilePath(path: string) {
  const name = posix.basename(path)
  return name.includes(".") || ["Dockerfile", "LICENSE", "Makefile", "Procfile", "README"].includes(name)
}

function directMaterializationSourceKey(source: ResolvedWorkspaceSource, options: WorkspaceMaterializeSourcesOptions | undefined): string | undefined {
  const requested = normalizeWorkspacePath(options?.path || "")
  if (!requested || !sourceMountContainsPath(source, requested) || requested === source.mountPath) return
  const sourcePath = source.mountPath ? requested.slice(source.mountPath.length + 1) : requested
  return sourcePath && looksLikeConcreteFilePath(sourcePath) ? sourcePath : undefined
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
  sources: ResolvedWorkspaceSource[],
  nextPaths: Set<string>,
  scope: WorkspaceMaterializeSourcesOptions | undefined,
  control: MaterializationControl,
  previousPaths = new Set<string>(),
  onRemoved?: (path: string, bytes: number) => void,
) {
  const entries = await store.list(source.mountPath, { recursive: true })
  const nextDirectories = new Set([...nextPaths].flatMap(path => parentDirectoryPaths(path)))
  const staleDirectories = new Set<string>()
  for (const entry of entries) {
    if (!materializationPathMatches(entry.path, scope)) continue
    if (nextPaths.has(entry.path) || entry.type !== "file") continue
    const file = await store.readFile(entry.path)
    const currentOwner = file?.metadata?.source
    const overlapsAnotherSource = sources.some(candidate =>
      candidate.key !== source.key
      && candidate.mountPath.length >= source.mountPath.length
      && sourceMountContainsPath(candidate, entry.path),
    )
    if (currentOwner === source.key || (currentOwner === undefined && (previousPaths.has(entry.path) || !overlapsAnotherSource))) {
      for (const directory of parentDirectoryPaths(entry.path)) staleDirectories.add(directory)
      await control.mutate(() => store.rm(entry.path, { force: true }))
      onRemoved?.(entry.path, file ? contentSize(file.content) : 0)
    }
  }
  for (const entry of entries.filter(entry => entry.type === "directory" && staleDirectories.has(entry.path) && !nextDirectories.has(entry.path)).sort((a, b) => b.path.length - a.path.length)) {
    try {
      await control.mutate(() => store.rm(entry.path, { force: true }))
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
  const { path, sourcePath } = normalizeSourceItemPath(source, item, { operation: "source materialization" })
  return {
    item,
    metadata: createLazyMaterializedMetadata({
      sourceKey: source.key,
      sourcePath,
      validate: source.validate,
    }, item, upstreamMeta),
    path,
    ...sourceItemContent(item),
  }
}

function sourceItemContent(item: WorkspaceSourceItem): Pick<MaterializationEntry, "content" | "contentStream"> {
  if (item.contentStream) {
    if (item.content !== undefined || item.data !== undefined) {
      throw workspaceError("[vitehub] Workspace source items cannot define contentStream with content or data.")
    }
    return { contentStream: item.contentStream }
  }
  return { content: item.content ?? (item.data === undefined ? "" : JSON.stringify(item.data, null, 2)) }
}

async function* iterateMaterializationEntries(
  source: ResolvedWorkspaceSource,
  ctx: SourceContext,
  store: WorkspaceStore,
  snapshot: SourceSnapshotMetadata | undefined,
  configHash: string,
  options: WorkspaceMaterializeSourcesOptions | undefined,
): AsyncGenerator<MaterializationEntry> {
  const directKey = directMaterializationSourceKey(source, options)
  if (directKey) {
    const entry = createMaterializationEntry(source, await source.source.getItem(directKey, ctx), undefined)
    if (materializationPathMatches(entry.path, options)) yield entry
    return
  }

  if (source.source.getItems) {
    for await (const item of iterateSourceItems(source, ctx)) {
      const upstreamMeta = item.metadata ?? await source.source.getMeta?.(item.key, ctx)
      const entry = createMaterializationEntry(source, item, upstreamMeta)
      if (materializationPathMatches(entry.path, options)) yield entry
    }
    return
  }

  for (const key of await source.source.getKeys(ctx)) {
    const upstreamMeta = await source.source.getMeta?.(key, ctx)
    const { path, sourcePath } = normalizeWorkspaceSourceItemPath(source, key, { operation: "source materialization" })
    if (!materializationPathMatches(path, options)) continue
    const previous = materializedItemMeta(snapshot, configHash, path)
    if (upstreamMeta && previous?.source === source.key && previous.sourcePath === sourcePath && !hasSourceMetaChanged(previous, upstreamMeta)) {
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
  control: MaterializationControl = {
    isCurrent: () => true,
    async mutate(operation) { return await operation() },
    async checkpoint(operation) { return await operation() },
  },
): Promise<WorkspaceMaterializeSourcesResult> {
  const assertCurrent = () => {
    if (!control.isCurrent()) throw options.abortSignal?.reason ?? workspaceError("[vitehub] Workspace source materialization was superseded.")
  }
  const started = Date.now()
  const configuredSources = normalizeWorkspaceSources(definition.sources)
  const sources = configuredSources.filter(source => shouldMaterializeSource(source, options))
  const resultSources: WorkspaceSourceMaterializationStatus[] = []
  let files = 0
  let directories = 0
  let bytes = 0

  for (const source of sources) {
    throwIfAborted(options.abortSignal)
    const sourceStarted = Date.now()
    await reportMaterializationProgress(options, source, { status: "started" })
    let configHash: string
    let existing: SourceSnapshotMetadata | undefined
    try {
      configHash = await sourceConfigHash(source)
      existing = await readSourceSnapshotMetadata(store, source.key)
    }
    catch (error) {
      const durationMs = Date.now() - sourceStarted
      const message = error instanceof Error ? error.message : String(error)
      const failed = {
        counts: emptyMaterializationCounts(), durationMs, error: message, mountPath: source.mountPath,
        provider: source.source.name, source: source.key, status: "error" as const,
      }
      resultSources.push(failed)
      await reportMaterializationProgress(options, source, { counts: failed.counts, durationMs, error: message, status: "failed" })
      if (options.abortSignal?.aborted) throw error
      continue
    }
    const completeSource = materializesCompleteSource(source, options)
    const cacheHit = completeSource && isSnapshotFresh(existing, source, configHash)
    const cacheStatus = materializationCacheStatus(source, completeSource, cacheHit)
    if (cacheHit) {
      const durationMs = Date.now() - sourceStarted
      const cachedPaths = Object.keys(existing?.items || {})
      const cachedFiles = cachedPaths.length || existing?.files || 0
      const counts = { ...emptyMaterializationCounts(), unchanged: cachedFiles }
      const ready: WorkspaceSourceMaterializationStatus = {
        cacheStatus, counts, durationMs,
        source: source.key,
        mountPath: source.mountPath,
        provider: source.source.name,
        status: "ready",
        revision: existing?.revision,
        materializedAt: existing?.materializedAt,
        files: existing?.files,
        bytes: existing?.bytes,
      }
      const paths = materializationPaths(options, cachedPaths.map(path => ({ path, status: "unchanged" as const })))
      if (paths) ready.paths = paths
      resultSources.push(ready)
      files += cachedFiles
      bytes += existing?.bytes || 0
      await reportMaterializationProgress(options, source, {
        bytes: existing?.bytes || 0,
        cacheStatus, counts, durationMs,
        files: cachedFiles,
        revision: existing?.revision,
        status: "completed",
      })
      continue
    }

    let revision = existing?.revision
    const itemMetadata: Record<string, LazyMaterializedMetadata> = existing?.configHash === configHash
      ? { ...existing.items }
      : {}
    if (completeSource) {
      assertCurrent()
      await control.mutate(() => writeSourceSnapshotMetadata(store, {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "updating",
        revision,
        items: checkpointItems(itemMetadata),
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }))
    }

    let sourceFiles = 0
    let sourceBytes = 0
    let persistedBytesDelta = 0
    let lastProgressAt = 0
    const counts = emptyMaterializationCounts()
    const paths: WorkspaceSourceMaterializationPathResult[] = []
    try {
      const ctx = createSourceContext(definition, source, store, { abortSignal: options.abortSignal })
      throwIfAborted(options.abortSignal)
      await prepareWorkspaceSource(source.source, ctx)
      throwIfAborted(options.abortSignal)
      if (source.mountPath) {
        await control.mutate(() => store.mkdir(source.mountPath, { recursive: true }))
      }

      revision = ctx.revision
      const directorySet = new Set<string>(source.mountPath ? [source.mountPath] : [])
      const nextPaths = new Set<string>()
      for await (const entry of iterateMaterializationEntries(source, ctx, store, existing, configHash, options)) {
        throwIfAborted(options.abortSignal)
        const path = entry.path
        nextPaths.add(path)
        const parts = path.split("/")
        for (let index = 1; index < parts.length; index++) directorySet.add(parts.slice(0, index).join("/"))
        if (entry.reused) {
          itemMetadata[path] = entry.metadata
          sourceFiles++
          const reusedFile = entry.reused.size === undefined ? await store.readFile(path) : undefined
          sourceBytes += entry.reused.size ?? (reusedFile ? contentSize(reusedFile.content) : 0)
          counts.unchanged++
          paths.push({ path, status: "unchanged" })
          if (shouldReportMaterializationUpdate(lastProgressAt, sourceFiles)) {
            lastProgressAt = Date.now()
            await reportMaterializationProgress(options, source, {
              bytes: sourceBytes,
              cacheStatus,
              counts: { ...counts },
              files: sourceFiles,
              revision,
              status: "updating",
            })
          }
          continue
        }
        const item = entry.item!
        const metadata = item.metadata || {}
        const previousStat = await store.stat(path)
        const previous = await store.readFile(path)
        const previousExists = previousStat?.type === "file" || Boolean(previous)
        const fileMetadata = {
          ...metadata,
          ...entry.metadata,
          source: source.key,
        }
        const written = await writeMaterializedFile(store, path, {
          path,
          content: entry.content,
          contentStream: entry.contentStream,
          mediaType: item.mediaType,
          metadata: fileMetadata,
        }, control, previous?.content)
        const tracked = Object.hasOwn(itemMetadata, path)
        const previousItemMetadata = itemMetadata[path]
        itemMetadata[path] = {
          ...entry.metadata,
          materializedAttributes: true,
          materializedBytes: written.size || 0,
          materializedMediaType: item.mediaType,
          materializedMetadata: observableFileMetadata(fileMetadata),
        }
        sourceFiles++
        sourceBytes += written.size || 0
        persistedBytesDelta += (written.size || 0) - (tracked
          ? previousItemMetadata?.materializedBytes ?? previousStat?.size ?? (previous ? contentSize(previous.content) : 0)
          : 0)
        const status = previous && (entry.contentStream ? written.contentEqual : contentEquals(previous.content, entry.content ?? ""))
          && fileAttributesEqual(previous, previousItemMetadata, item.mediaType, fileMetadata)
          ? "unchanged" as const
          : previousExists ? "updated" as const : "added" as const
        counts[status]++
        paths.push({ path, status })
        if (shouldReportMaterializationUpdate(lastProgressAt, sourceFiles)) {
          lastProgressAt = Date.now()
          await reportMaterializationProgress(options, source, {
            bytes: sourceBytes,
            cacheStatus,
            counts: { ...counts },
            files: sourceFiles,
            revision,
            status: "updating",
          })
        }
      }
      throwIfAborted(options.abortSignal)
      await removeStaleMaterializedSourceFiles(store, source, configuredSources, nextPaths, options, control, new Set(Object.keys(existing?.items || {})), (path, removedBytes) => {
        counts.removed++
        if (Object.hasOwn(itemMetadata, path)) persistedBytesDelta -= itemMetadata[path]?.materializedBytes ?? removedBytes
        delete itemMetadata[path]
        paths.push({ path, status: "removed" })
      })
      const readyItems = Object.fromEntries([...nextPaths].flatMap((path) => {
        const metadata = itemMetadata[path]
        return metadata ? [[path, metadata] as const] : []
      }))

      const ready: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "ready",
        revision,
        materializedAt: new Date().toISOString(),
        files: sourceFiles,
        bytes: sourceBytes,
        items: readyItems,
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      if (completeSource) await control.mutate(() => writeSourceSnapshotMetadata(store, ready))
      else if (existing?.configHash === configHash) {
        const scopedItems = checkpointItems(itemMetadata)
        await control.mutate(() => writeSourceSnapshotMetadata(store, {
          ...existing,
          bytes: Math.max(0, (existing.bytes || 0) + persistedBytesDelta),
          files: scopedItems ? Object.keys(scopedItems).length : 0,
          items: scopedItems,
        }))
      }
      const durationMs = Date.now() - sourceStarted
      const resultSource: WorkspaceSourceMaterializationStatus = {
        ...ready, cacheStatus, counts: { ...counts }, durationMs, provider: source.source.name,
      }
      const reportedPaths = materializationPaths(options, paths)
      if (reportedPaths) resultSource.paths = reportedPaths
      resultSources.push(resultSource)
      files += sourceFiles
      bytes += sourceBytes
      directories += directorySet.size
      await reportMaterializationProgress(options, source, {
        bytes: sourceBytes,
        cacheStatus,
        counts: { ...counts },
        directories: directorySet.size,
        durationMs,
        files: sourceFiles,
        revision,
        status: "completed",
      })
    }
    catch (error) {
      const failed: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        status: "error",
        revision,
        error: error instanceof Error ? error.message : String(error),
        files: sourceFiles,
        bytes: sourceBytes,
        items: checkpointItems(itemMetadata),
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      const checkpoint = options.abortSignal?.aborted
        ? completeSource
          ? { ...failed, status: "updating" as const, error: undefined }
          : existing?.configHash === configHash
            ? { ...existing, items: checkpointItems(itemMetadata) }
            : undefined
        : failed
      if (checkpoint && control.isCurrent()) await control.checkpoint(() => writeSourceSnapshotMetadata(store, checkpoint))
      const durationMs = Date.now() - sourceStarted
      const failedSource: WorkspaceSourceMaterializationStatus = {
        ...failed, cacheStatus, counts: { ...counts }, durationMs, provider: source.source.name,
      }
      const reportedPaths = materializationPaths(options, paths)
      if (reportedPaths) failedSource.paths = reportedPaths
      resultSources.push(failedSource)
      await reportMaterializationProgress(options, source, {
        bytes: sourceBytes,
        cacheStatus,
        counts: { ...counts },
        durationMs,
        error: failed.error,
        files: sourceFiles,
        revision,
        status: "failed",
      })
      if (options.abortSignal?.aborted) throw error
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
  if (!file) throw workspaceError(`[vitehub] Workspace file does not exist: ${resolution.workspacePath}.`)
  return decodeFile(file.content, options)
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
  control?: MaterializationControl,
  previousContent?: string | Uint8Array,
): Promise<{ contentEqual?: boolean, size?: number }> {
  if (file.contentStream) {
    if (store.writeFileStream) {
      let size = 0
      const previousBytes = previousContent === undefined
        ? undefined
        : previousContent instanceof Uint8Array ? previousContent : new TextEncoder().encode(previousContent)
      let comparedBytes = 0
      let contentEqual = previousBytes !== undefined
      const content = (async function* () {
        for await (const chunk of contentStreamChunks(file.contentStream!)) {
          size += chunk.byteLength
          if (previousBytes) {
            if (comparedBytes + chunk.byteLength > previousBytes.byteLength) contentEqual = false
            else {
              for (let index = 0; index < chunk.byteLength; index++) {
                if (chunk[index] !== previousBytes[comparedBytes + index]) {
                  contentEqual = false
                  break
                }
              }
            }
            comparedBytes += chunk.byteLength
          }
          yield chunk
        }
      })()
      const write = () => store.writeFileStream!(path, {
        path: file.path,
        content,
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      if (control) await control.mutate(write)
      else await write()
      return { contentEqual: contentEqual && comparedBytes === previousBytes?.byteLength, size }
    }
    const content = await contentStreamToBytes(file.contentStream)
    if (control) await control.mutate(() => store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata }))
    else await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
    return { contentEqual: previousContent !== undefined && contentEquals(previousContent, content), size: content.byteLength }
  }

  const content = file.content ?? ""
  if (control) await control.mutate(() => store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata }))
  else await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
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
    const text = file.content instanceof Uint8Array ? new TextDecoder().decode(file.content) : file.content
    result.push(...searchText(entry.path, text, { ...query, limit: limit - result.length }))
    if (result.length >= limit) break
  }

  return result.slice(0, limit)
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

function normalizeSourcePath(source: ResolvedWorkspaceSource, workspacePath: string) {
  if (workspacePath === source.mountPath) return ""
  return source.mountPath && workspacePath.startsWith(`${source.mountPath}/`)
    ? normalizeWorkspacePath(workspacePath.slice(source.mountPath.length + 1))
    : normalizeWorkspacePath(workspacePath)
}

function readStringMeta(meta: Record<string, unknown> | undefined, key: string) {
  const value = meta?.[key]
  return Object.prototype.toString.call(value) === "[object String]" ? String(value) : undefined
}

function readDigest(meta: Record<string, unknown> | undefined) {
  return readStringMeta(meta, "digest") || readStringMeta(meta, "sha")
}
