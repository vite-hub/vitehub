import { posix } from "node:path"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

import { workspaceError } from "../core/errors.ts"
import { contentStreamChunks, contentStreamToBytes, decodeFile, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath } from "./config.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import { normalizeMetadataValue, normalizeSourceFileMetadata } from "./file-metadata.ts"
import { normalizeSourceItemPath, normalizeWorkspaceSourceItemPath } from "./source-items.ts"
import { searchText } from "../core/search.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { withWorkspaceStoreMutation } from "../storage/mutation.ts"
import { workspaceStoreIdentity } from "../storage/identity.ts"
import { resolveWorkspaceStoreTarget } from "../storage/target.ts"
import { recordWorkspaceFileOwner, readWorkspaceFileOwner, removeWorkspaceFileOwner, removeWorkspaceOwnedFile } from "./file-ownership.ts"
import { withWorkspaceFileCheckpoint } from "./owned-write.ts"
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
  migrationPending?: true
  materializedAttributes?: true
  materializedContentDigest?: string
  materializedBytes?: number
  materializedMediaType?: string
  materializedMetadata?: Record<string, unknown>
}

interface SourceSnapshotMetadata extends Omit<WorkspaceSourceMaterializationStatus, "cacheStatus" | "counts" | "durationMs" | "paths" | "provider"> {
  configHash: string
  cacheMaxAge?: number
  ownsMount?: boolean
  ownedAncestors?: string[]
  ownedDirectories?: string[]
  items?: Record<string, LazyMaterializedMetadata>
}

interface MaterializedStartupSource {
  key: string
  mountPath: string
}

const startupSourcesMetaKey = (workspace: string) => `workspace:${workspace}:startup-sources`
const startupWorkspacesMetaKey = "workspace:startup-source-workspaces"
const volatileSnapshots = new WeakMap<object, Map<string, SourceSnapshotMetadata | undefined>>()
const volatileStartupIndexes = new WeakMap<object, Map<string, string[] | MaterializedStartupSource[]>>()
const startupReconciliationByStore = new WeakMap<WorkspaceStore, Promise<void>>()
const activeStartupSourcesByStore = new WeakMap<WorkspaceStore, Map<string, Set<ResolvedWorkspaceSource>>>()

export interface MaterializationControl {
  isCurrent(): boolean
  mutate<T>(operation: () => Promise<T>): Promise<T>
  checkpoint<T>(operation: () => Promise<T>): Promise<T>
}

export function sourceSnapshotMetaKey(workspace: string, sourceKey: string) {
  return `workspace:${encodeURIComponent(workspace)}:source:${encodeURIComponent(sourceKey)}:snapshot`
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

async function sourceConfigHash(source: SourceConfiguration, store: Pick<WorkspaceStore, "getMeta">) {
  const target = await resolveWorkspaceStoreTarget(store)
  const version: { fileMetadataVersion?: number } = {}
  // Only local files need legacy snapshots replayed to persist ownership.
  if (target?.provider === "local") version.fileMetadataVersion = 1
  return await sha256({ ...version, ...sourceConfigFingerprint(source) })
}

function isSnapshotFresh(meta: SourceSnapshotMetadata | undefined, source: ResolvedWorkspaceSource, configHash: string) {
  if (!meta || meta.status !== "ready" || meta.configHash !== configHash) return false
  if (!source.cache) return false
  const maxAge = source.cache.maxAge ?? Number.NaN
  if (!Number.isFinite(maxAge)) return false
  if (!meta.materializedAt) return false
  return Date.now() - Date.parse(meta.materializedAt) <= maxAge * 1000
}

async function readSourceSnapshotMetadata(store: Pick<WorkspaceStore, "getMeta">, workspace: string, sourceKey: string, source?: SourceConfiguration) {
  const volatile = volatileSnapshots.get(workspaceStoreIdentity(store))
  const key = sourceSnapshotMetaKey(workspace, sourceKey)
  if (volatile?.has(key)) return volatile.get(key)
  // SAFETY: This private metadata key is written exclusively by writeSourceSnapshotMetadata below.
  const snapshot = await store.getMeta?.(sourceSnapshotMetaKey(workspace, sourceKey)) as SourceSnapshotMetadata | undefined
  if (snapshot || !source) return snapshot
  // Reuse an older cache only for the same configuration. Cleanup callers do
  // not pass a Source, so they cannot claim an unscoped snapshot.
  // SAFETY: Older releases wrote SourceSnapshotMetadata under this private key.
  const legacy = await store.getMeta?.(`source:${sourceKey}:snapshot`) as SourceSnapshotMetadata | undefined
  return legacy?.configHash === await sourceConfigHash(source, store) ? legacy : undefined
}

export async function invalidateSourceSnapshot(store: WorkspaceStore, workspace: string, sourceKey: string) {
  const snapshot = await readSourceSnapshotMetadata(store, workspace, sourceKey)
  // Configuration changes invalidate reuse, but old file digests still prove cleanup ownership.
  if (snapshot) await writeSourceSnapshotMetadata(store, workspace, { ...snapshot, status: "updating" })
}

export async function hasCurrentSourceSnapshot(store: WorkspaceStore, workspace: string, source: ResolvedWorkspaceSource, verifyOwnership: boolean | "workspace" = false) {
  const configHash = await sourceConfigHash(source, store)
  const meta = await readSourceSnapshotMetadata(store, workspace, source.key, source)
  if (meta?.status !== "ready" || meta.configHash !== configHash) return false
  if (verifyOwnership === "workspace") {
    // Refresh may intentionally remove an empty mount and relinquish its ownership.
    if (Object.keys(meta.items || {}).length === 0 && meta.ownsMount !== false && meta.mountPath && (await store.stat(meta.mountPath))?.type !== "directory") return false
    // Normal reads preserve external edits, but cannot reuse files owned by another Workspace.
    for (const path of Object.keys(meta.items || {})) {
      const file = await store.readFile(path)
      if (!file) return false
      const inlineOwner = file.metadata?.workspaceSourceOwner
      if (inlineOwner !== undefined && inlineOwner !== workspace) return false
      const owner = await readWorkspaceFileOwner(store, path)
      if (!owner || owner.workspace === workspace || !owner.digest) continue
      if (await sha256(file.content) === owner.digest) return false
    }
    return true
  }
  return !verifyOwnership || await snapshotHasCurrentOwners(store, workspace, source, meta)
}

async function snapshotHasCurrentOwners(store: WorkspaceStore, workspace: string, source: ResolvedWorkspaceSource, meta: SourceSnapshotMetadata) {
  if (Object.keys(meta.items || {}).length === 0 && meta.mountPath && (await store.stat(meta.mountPath))?.type !== "directory") return false
  for (const path of Object.keys(meta.items || {})) {
    const stat = await store.stat(path)
    if (!await materializedFileHasCurrentOwner(store, workspace, source.key, path, stat)) return false
  }
  return true
}

async function materializedFileHasCurrentOwner(store: WorkspaceStore, workspace: string, source: string, path: string, stat: WorkspaceStat | undefined) {
  if (stat?.type !== "file") return false
  if (stat.metadata?.workspaceSourceOwner === workspace && stat.metadata.source === source) return true
  if (stat.metadata?.workspaceSourceOwner !== undefined && stat.metadata.workspaceSourceOwner !== workspace) return false
  if (stat.metadata?.source !== undefined && stat.metadata.source !== source) return false
  const durable = await readWorkspaceFileOwner(store, path)
  if (durable?.workspace !== workspace || durable.source !== source || !durable.digest) return false
  const file = await store.readFile(path)
  return !!file && await sha256(file.content) === durable.digest
}

export async function hasFreshSourceSnapshot(store: WorkspaceStore, workspace: string, source: ResolvedWorkspaceSource) {
  const configHash = await sourceConfigHash(source, store)
  const meta = await readSourceSnapshotMetadata(store, workspace, source.key, source)
  return !!meta && isSnapshotFresh(meta, source, configHash) && await snapshotHasCurrentOwners(store, workspace, source, meta)
}

export async function readCurrentSourceSnapshot(store: Pick<WorkspaceStore, "getMeta">, workspace: string, source: SourceConfiguration) {
  const configHash = await sourceConfigHash(source, store)
  const snapshot = await readSourceSnapshotMetadata(store, workspace, source.key, source)
  return snapshot?.configHash === configHash ? snapshot : undefined
}

export async function sourceSnapshotOwnsAnyPath(store: WorkspaceStore, workspace: string, sourceKey: string, paths: Iterable<string>): Promise<boolean | undefined> {
  const meta = await readSourceSnapshotMetadata(store, workspace, sourceKey)
  if (!meta || meta.status !== "ready") return undefined
  const ownedPaths = new Set(Object.keys(meta.items || {}))
  return [...paths].some(path => ownedPaths.has(normalizeWorkspacePath(path)))
}

async function writeSourceSnapshotMetadata(store: WorkspaceStore, workspace: string, metadata: SourceSnapshotMetadata) {
  let snapshots = volatileSnapshots.get(workspaceStoreIdentity(store))
  if (!snapshots) {
    snapshots = new Map()
    volatileSnapshots.set(workspaceStoreIdentity(store), snapshots)
  }
  const key = sourceSnapshotMetaKey(workspace, metadata.source)
  snapshots.set(key, metadata)
  if (store.getMeta && store.setMeta) {
    await store.setMeta(key, metadata)
    snapshots.delete(key)
  }
}

function materializedItemMeta(
  snapshot: SourceSnapshotMetadata | undefined,
  configHash: string,
  path: string,
) {
  if (!snapshot || snapshot.configHash !== configHash) return undefined
  if (snapshot.status !== "ready" && snapshot.status !== "updating" && snapshot.status !== "error") return undefined
  const item = snapshot.items?.[path]
  return item?.migrationPending ? undefined : item
}

function checkpointItems(items: Record<string, LazyMaterializedMetadata>) {
  return Object.keys(items).length ? items : undefined
}

function contentSize(content: string | Uint8Array) {
  return content instanceof Uint8Array ? content.byteLength : new TextEncoder().encode(content).byteLength
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
  if (options?.sources && !options.sources.includes(source.key)) return false
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

function sourceOwnsDirectory(source: Pick<ResolvedWorkspaceSource, "mountPath">, path: string) {
  return !source.mountPath || path === source.mountPath || path.startsWith(`${source.mountPath}/`)
}

async function removeStaleMaterializedSourceFiles(
  store: WorkspaceStore,
  workspace: string,
  source: ResolvedWorkspaceSource,
  sources: ResolvedWorkspaceSource[],
  nextPaths: Set<string>,
  scope: WorkspaceMaterializeSourcesOptions | undefined,
  control: MaterializationControl,
  previousSnapshot: SourceSnapshotMetadata | undefined,
  ownedDirectories: Set<string>,
  onRemoved?: (path: string, bytes: number) => void,
) {
  const previousPaths = new Set(Object.keys(previousSnapshot?.items || {}))
  const nextDirectories = new Set([...nextPaths].flatMap(path => parentDirectoryPaths(path)))
  // Owned directories survive failed cleanup after their last file was removed.
  const staleDirectories = new Set((previousSnapshot?.ownedDirectories || []).filter(path =>
    sourceOwnsDirectory(source, path) && materializationPathMatches(path, scope),
  ))
  const removedDirectories = new Set<string>()
  // Build cleanup leaves an empty snapshot object; only that missing index needs recovery.
  // With metadata support, an absent snapshot is a first startup with no owned paths.
  const hasStartupIndex = source.materialize === "startup" && store.getMeta && store.setMeta
    && previousSnapshot?.mountPath !== undefined
  const entries = hasStartupIndex
    ? await Promise.all([...previousPaths].map(async path => await store.stat(path)))
    : source.mountPath
      ? await store.list(source.mountPath, { recursive: true })
      : previousPaths.size || (store.getMeta && store.setMeta && (!previousSnapshot || previousSnapshot.items))
        ? await Promise.all([...previousPaths].map(async path => await store.stat(path)))
        : await store.list("", { recursive: true })
  for (const path of previousPaths) {
    if (!nextPaths.has(path) && materializationPathMatches(path, scope)) {
      await control.mutate(() => withWorkspaceStoreMutation(store, () => readWorkspaceFileOwner(store, path, true)))
    }
  }
  for (const entry of entries) {
    if (!entry || !materializationPathMatches(entry.path, scope) || nextPaths.has(entry.path) || entry.type !== "file") continue
    await control.mutate(() => withWorkspaceStoreMutation(store, async () => {
      const file = await store.readFile(entry.path)
      // Legacy snapshots can be shared; only file ownership authorizes deletion.
      const durableOwner = await readWorkspaceFileOwner(store, entry.path)
      if (file?.metadata?.workspaceSourceOwner !== workspace && durableOwner?.workspace !== workspace) return
      const currentOwner = file?.metadata?.source ?? durableOwner?.source
      if (source.materialize === "startup" && store.getMeta && store.setMeta && !previousSnapshot && currentOwner !== undefined) return
      const recordedDigest = previousSnapshot?.items?.[entry.path]?.materializedContentDigest
      // During legacy snapshot migration, durable ownership is only valid when it
      // matches the snapshot digest that authorized cleanup.
      if (file?.metadata?.source === undefined && durableOwner?.digest !== undefined
        && recordedDigest !== undefined && durableOwner.digest !== recordedDigest) return
      // Durable ownership survives direct writes on every Store, not just local files.
      if (file?.metadata?.source === undefined
        && (!durableOwner?.digest || !file || await sha256(file.content) !== durableOwner.digest)) {
        if (durableOwner?.workspace === workspace && durableOwner.source === source.key) await removeWorkspaceFileOwner(store, entry.path)
        return
      }
      // Persisted ownership can outlive an external edit. Preserve changed content.
      if (previousSnapshot?.items && (!recordedDigest || !file || await sha256(file.content) !== recordedDigest)) {
        if (durableOwner?.workspace === workspace && durableOwner.source === source.key) await removeWorkspaceFileOwner(store, entry.path)
        return
      }
      if (currentOwner === undefined && previousSnapshot?.items && !recordedDigest) return
      const overlapsAnotherSource = sources.some(candidate =>
        candidate.key !== source.key
        && candidate.mountPath.length >= source.mountPath.length
        && sourceMountContainsPath(candidate, entry.path),
      )
      if (currentOwner === source.key || (currentOwner === undefined && (previousPaths.has(entry.path) || (Boolean(source.mountPath) && !overlapsAnotherSource)))) {
        for (const directory of parentDirectoryPaths(entry.path)) {
          if (sourceOwnsDirectory(source, directory)
            && (directory !== source.mountPath || previousSnapshot?.ownsMount)) staleDirectories.add(directory)
        }
        for (const candidate of sources) {
          if (candidate.key === source.key) continue
          const retainedSnapshot = await readSourceSnapshotMetadata(store, workspace, candidate.key)
          if (retainedSnapshot?.status !== "ready" || !retainedSnapshot.items?.[entry.path]) continue
          await writeSourceSnapshotMetadata(store, workspace, { ...retainedSnapshot, status: "updating" })
        }
        await removeWorkspaceOwnedFile(store, entry.path)
        onRemoved?.(entry.path, file ? contentSize(file.content) : 0)
      }
    }))
  }
  const cleanupDirectories = [...staleDirectories].filter(path => !nextDirectories.has(path)).sort((a, b) => b.length - a.length)
  // Checkpoint every selected directory even if inspection or removal fails.
  for (const path of cleanupDirectories) ownedDirectories.add(path)
  for (const path of cleanupDirectories) {
    if ((await store.stat(path))?.type === "file") {
      ownedDirectories.delete(path)
      removedDirectories.add(path)
      continue
    }
    if ((await store.list(path)).length || !store.removeEmptyDirectory) continue
    try {
      const removed = await control.mutate(async () => {
        // Mutation admission can wait while another writer replaces the path.
        if ((await store.list(path)).length) return false
        if ((await store.stat(path))?.type !== "directory") return true
        await store.removeEmptyDirectory!(path)
        return true
      })
      if (removed) {
        ownedDirectories.delete(path)
        removedDirectories.add(path)
      }
    }
    catch (error) {
      // Keep cleanup authority if this recovery inspection also fails.
      if (!(await store.list(path)).length) throw error
    }
  }
  return removedDirectories
}

export async function reconcileRemovedStartupSources(
  workspace: string,
  store: WorkspaceStore,
  currentSources: ResolvedWorkspaceSource[],
  control: MaterializationControl = {
    isCurrent: () => true,
    async mutate(operation) { return await operation() },
    async checkpoint(operation) { return await operation() },
  },
  materializationStore = store,
) {
  // Per-source materializations share removed owners, so finish their cleanup
  // before another source can observe and delete the same files.
  const previous = startupReconciliationByStore.get(materializationStore)
  const current = (async () => {
    await previous
    await reconcileRemovedStartupSourcesInternal(workspace, store, currentSources, control, activeStartupSourcesByStore.get(materializationStore)?.get(workspace))
  })()
  const tail = current.catch(() => {})
  startupReconciliationByStore.set(materializationStore, tail)
  try {
    await current
  }
  finally {
    if (startupReconciliationByStore.get(materializationStore) === tail) startupReconciliationByStore.delete(materializationStore)
  }
}

async function reconcileRemovedStartupSourcesInternal(
  workspace: string,
  store: WorkspaceStore,
  currentSources: ResolvedWorkspaceSource[],
  control: MaterializationControl,
  activeSources: Set<ResolvedWorkspaceSource> = new Set(),
) {
  const workspaceIndex = await readStartupIndex(store, startupWorkspacesMetaKey)
  const workspaces = new Set(Array.isArray(workspaceIndex)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate persisted Workspace names at the untyped Store boundary.
    ? workspaceIndex.filter((name): name is string => typeof name === "string")
    : [])
  workspaces.add(workspace)
  await control.checkpoint(() => writeStartupIndex(store, startupWorkspacesMetaKey, [...workspaces]))
  const value = await readStartupIndex(store, startupSourcesMetaKey(workspace))
  const previousSources = Array.isArray(value) ? value.filter(isMaterializedStartupSource) : []
  const currentMounts = new Map(currentSources.map(source => [source.key, source.mountPath]))
  const activeOwners = [...activeSources]
  const isActive = (source: MaterializedStartupSource) => activeOwners.some(active => active.key === source.key && active.mountPath === source.mountPath)
  const retainedSources: { workspace: string, source: MaterializedStartupSource }[] = currentSources.map(source => ({ workspace, source }))
  for (const otherWorkspace of workspaces) {
    if (otherWorkspace === workspace) continue
    const sources = await readStartupIndex(store, startupSourcesMetaKey(otherWorkspace))
    if (!Array.isArray(sources)) continue
    for (const source of sources.filter(isMaterializedStartupSource)) retainedSources.push({ workspace: otherWorkspace, source })
  }
  const pendingDirectoryCleanup: MaterializedStartupSource[] = []
  for (const source of previousSources.filter(source => currentMounts.get(source.key) !== source.mountPath && !isActive(source))) {
    const snapshot = await readSourceSnapshotMetadata(store, workspace, source.key)
    const invalidatedSnapshot = snapshot && snapshot.mountPath === undefined && snapshot.items === undefined
    if (snapshot?.mountPath !== source.mountPath && !invalidatedSnapshot) continue
    // Build synchronization can clear the index while owned files remain outside its mount.
    const previousPaths = invalidatedSnapshot
      ? (await store.list(source.mountPath, { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path)
      : Object.keys(snapshot?.items || {})
    const staleDirectories = new Set([...(snapshot?.ownedAncestors || []), ...(snapshot?.ownedDirectories || []).filter(path => sourceOwnsDirectory(source, path))])
    if (source.mountPath && snapshot?.ownsMount) staleDirectories.add(source.mountPath)
    for (const path of previousPaths) {
      await control.mutate(() => withWorkspaceStoreMutation(store, async () => {
        const file = await store.readFile(path)
        const durableOwner = await readWorkspaceFileOwner(store, path, true)
        if (!file) return
        if (file.metadata?.workspaceSourceOwner !== workspace && durableOwner?.workspace !== workspace) return
        const owner = file.metadata?.source ?? durableOwner?.source
        const recordedDigest = snapshot?.items?.[path]?.materializedContentDigest
        // A durable owner authorizes cleanup only while its written content remains.
        if (file.metadata?.source === undefined
          && (!durableOwner?.digest || await sha256(file.content) !== durableOwner.digest)) {
          if (durableOwner?.workspace === workspace && durableOwner.source === source.key) await removeWorkspaceFileOwner(store, path)
          return
        }
        // Persisted metadata does not prove that externally edited content is ours.
        if (snapshot?.items
          && (!recordedDigest || await sha256(file.content) !== recordedDigest)) {
          if (durableOwner?.workspace === workspace && durableOwner.source === source.key) await removeWorkspaceFileOwner(store, path)
          return
        }
        if (owner !== source.key && !(owner === undefined && recordedDigest && await sha256(file.content) === recordedDigest)) return
        for (const currentSource of currentSources) {
          const retainedSnapshot = await readSourceSnapshotMetadata(store, workspace, currentSource.key)
          if (retainedSnapshot?.status !== "ready" || !retainedSnapshot.items?.[path]) continue
          await writeSourceSnapshotMetadata(store, workspace, { ...retainedSnapshot, status: "updating" })
        }
        await removeWorkspaceOwnedFile(store, path)
      }))
    }
    let directoryCleanupUnavailable = false
    for (const path of [...staleDirectories].sort((a, b) => b.length - a.length)) {
      for (const { workspace: retainedWorkspace, source: currentSource } of retainedSources) {
        const retainedSnapshot = await readSourceSnapshotMetadata(store, retainedWorkspace, currentSource.key)
        if (retainedSnapshot?.mountPath !== currentSource.mountPath) continue
        const containsMount = pathContains(path, currentSource.mountPath)
        if (!containsMount && !Object.keys(retainedSnapshot.items || {}).some(item => pathContains(path, item))) continue
        // Retained files can keep this directory nonempty. Carry its ownership
        // forward even when the removal below cannot delete the shared mount.
        // This metadata-only transfer preserves the retained snapshot's validity.
        await control.checkpoint(() => writeSourceSnapshotMetadata(store, retainedWorkspace, {
          ...retainedSnapshot,
          ...(path === currentSource.mountPath
            ? { ownsMount: true }
            : containsMount
              ? { ownedAncestors: [...new Set([...(retainedSnapshot.ownedAncestors || []), path])] }
              : { ownedDirectories: [...new Set([...(retainedSnapshot.ownedDirectories || []), path])] }),
        }))
      }
      // Files left after ownership cleanup belong to retained Sources or users.
      // Decide whether removal is needed before calling the Store, so an actual
      // removal failure always preserves the snapshot and index for a retry.
      if ((await store.stat(path))?.type !== "directory" || (await store.list(path)).length) continue
      if (!store.removeEmptyDirectory) {
        directoryCleanupUnavailable = true
        continue
      }
      await control.mutate(async () => {
        if ((await store.list(path)).length || (await store.stat(path))?.type !== "directory") return
        await store.removeEmptyDirectory!(path)
      })
    }
    if (directoryCleanupUnavailable) {
      pendingDirectoryCleanup.push(source)
      continue
    }
    await control.checkpoint(async () => {
      const key = sourceSnapshotMetaKey(workspace, source.key)
      if (!store.getMeta || !store.setMeta) {
        let snapshots = volatileSnapshots.get(workspaceStoreIdentity(store))
        if (!snapshots) {
          snapshots = new Map()
          volatileSnapshots.set(workspaceStoreIdentity(store), snapshots)
        }
        // A read-only metadata backend can still contain an older snapshot.
        // Keep a tombstone so it cannot restore ownership in this Store.
        snapshots.set(key, undefined)
        return
      }
      await store.setMeta(key, {})
    })
  }
  // Register before materialization can persist files, including failed or interrupted attempts.
  // A newer definition must retain owners that can still write or checkpoint files.
  const trackedSources = [...currentSources, ...activeOwners, ...previousSources.filter(isActive), ...pendingDirectoryCleanup]
  const uniqueSources = trackedSources.filter((source, index) => trackedSources.findIndex(candidate => candidate.key === source.key && candidate.mountPath === source.mountPath) === index)
  await control.checkpoint(() => writeStartupIndex(store, startupSourcesMetaKey(workspace), uniqueSources.map(({ key, mountPath }) => ({ key, mountPath }))))
  if (!uniqueSources.length) {
    workspaces.delete(workspace)
    await control.checkpoint(() => writeStartupIndex(store, startupWorkspacesMetaKey, [...workspaces]))
  }
}

async function readStartupIndex(store: WorkspaceStore, key: string): Promise<unknown> {
  return volatileStartupIndexes.get(workspaceStoreIdentity(store))?.get(key) ?? await store.getMeta?.(key)
}

async function writeStartupIndex(store: WorkspaceStore, key: string, value: string[] | MaterializedStartupSource[]) {
  if (!store.getMeta || !store.setMeta) {
    let indexes = volatileStartupIndexes.get(workspaceStoreIdentity(store))
    if (!indexes) {
      indexes = new Map()
      volatileStartupIndexes.set(workspaceStoreIdentity(store), indexes)
    }
    indexes.set(key, value)
    return
  }
  await store.setMeta(key, value)
}

function isMaterializedStartupSource(value: unknown): value is MaterializedStartupSource {
  if (!hasRuntimeType(value, "object") || value === null) return false
  // SAFETY: hasRuntimeType establishes an object record before private metadata fields are read.
  const source = value as Record<string, unknown>
  return readStringMeta(source, "key") !== undefined && readStringMeta(source, "mountPath") !== undefined
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
  workspace: string,
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
      if (stat && await materializedFileHasCurrentOwner(store, workspace, source.key, path, stat)) {
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
  const activeByWorkspace = activeStartupSourcesByStore.get(store) ?? new Map<string, Set<ResolvedWorkspaceSource>>()
  const activeSources = activeByWorkspace.get(definition.name) ?? new Set<ResolvedWorkspaceSource>()
  const selectedSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "startup" && shouldMaterializeSource(source, options))
  for (const source of selectedSources) activeSources.add(source)
  activeByWorkspace.set(definition.name, activeSources)
  activeStartupSourcesByStore.set(store, activeByWorkspace)
  try {
    return await materializeWorkspaceSourcesInternal(definition, store, options, control)
  }
  finally {
    for (const source of selectedSources) activeSources.delete(source)
    if (!activeSources.size) activeByWorkspace.delete(definition.name)
    if (!activeByWorkspace.size) activeStartupSourcesByStore.delete(store)
  }
}

async function materializeWorkspaceSourcesInternal(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceMaterializeSourcesOptions,
  control: MaterializationControl,
): Promise<WorkspaceMaterializeSourcesResult> {
  const workspace = definition.name
  const assertCurrent = () => {
    if (!control.isCurrent()) throw options.abortSignal?.reason ?? workspaceError("[vitehub] Workspace source materialization was superseded.")
  }
  const started = Date.now()
  const configuredSources = normalizeWorkspaceSources(definition.sources)
  const sources = configuredSources.filter(source => shouldMaterializeSource(source, options))
  const startupSources = configuredSources.filter(source => source.materialize === "startup")
  const rootMaterialization = !normalizeWorkspacePath(options.path || "")
  const selectedStartupSource = sources.some(source => source.materialize === "startup")
  const reconcileStartupSources = selectedStartupSource || rootMaterialization && !options.sources?.length
  if (reconcileStartupSources) {
    await reconcileRemovedStartupSources(definition.name, store, startupSources, control)
  }
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
      configHash = await sourceConfigHash(source, store)
      existing = await readSourceSnapshotMetadata(store, workspace, source.key, source)
      if (existing && !await store.getMeta?.(sourceSnapshotMetaKey(workspace, source.key))) {
        const adopted = existing
        await control.checkpoint(() => writeSourceSnapshotMetadata(store, workspace, adopted))
      }
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
    const cacheHit = completeSource && !!existing && isSnapshotFresh(existing, source, configHash)
      && await snapshotHasCurrentOwners(store, workspace, source, existing)
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

    let ownsMount = Boolean(source.mountPath)
      && existing?.mountPath === source.mountPath && existing.ownsMount === true
      && Boolean(await store.stat(source.mountPath))
    const ownedAncestors = [...(existing?.mountPath === source.mountPath ? existing.ownedAncestors || [] : [])]
    const ownedDirectories = new Set(existing?.mountPath === source.mountPath ? existing.ownedDirectories : [])
    let revision = existing?.revision
    const retainPriorItems = existing?.configHash === configHash
      || !completeSource && source.materialize === "startup" && existing?.mountPath === source.mountPath
    const itemMetadata: Record<string, LazyMaterializedMetadata> = existing?.configHash === configHash
      ? { ...existing.items }
      : Object.fromEntries(Object.entries(existing?.items || {}).map(([path, metadata]) =>
        [path, { ...metadata, migrationPending: true as const }]))
    if (completeSource) {
      assertCurrent()
      await control.mutate(() => writeSourceSnapshotMetadata(store, workspace, {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        ownedAncestors,
        ownedDirectories: [...ownedDirectories],
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
        await control.mutate(async () => {
          const mountExists = Boolean(await store.stat(source.mountPath))
          const missingAncestors = []
          for (const path of parentDirectoryPaths(source.mountPath)) {
            if (!await store.stat(path)) missingAncestors.push(path)
          }
          await store.mkdir(source.mountPath, { recursive: true })
          ownsMount = ownsMount || !mountExists
          for (const path of missingAncestors) {
            if (!ownedAncestors.includes(path)) ownedAncestors.push(path)
          }
        })
      }

      revision = ctx.revision
      const directorySet = new Set<string>(source.mountPath ? [source.mountPath] : [])
      const nextPaths = new Set<string>()
      for await (const entry of iterateMaterializationEntries(source, ctx, store, existing, configHash, options, workspace)) {
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
        const metadata = normalizeSourceFileMetadata(item.metadata || {})
        const previousStat = await store.stat(path)
        const previous = entry.contentStream && store.writeFileStream ? undefined : await store.readFile(path)
        const previousExists = previousStat?.type === "file" || Boolean(previous)
        const fileMetadata = normalizeSourceFileMetadata({
          ...metadata,
          ...entry.metadata,
          source: source.key,
          workspaceSourceOwner: workspace,
        })
        const missingDirectories: string[] = []
        for (const directory of parentDirectoryPaths(path)) {
          if (directory !== source.mountPath && sourceOwnsDirectory(source, directory) && !await store.stat(directory)) missingDirectories.push(directory)
        }
        const tracked = Object.hasOwn(itemMetadata, path)
        const previousItemMetadata = itemMetadata[path]
        const written = await control.mutate(() => withWorkspaceStoreMutation(store, async () => {
          const write = () => writeMaterializedFile(store, path, {
            path,
            content: entry.content,
            contentStream: entry.contentStream,
            mediaType: item.mediaType,
            metadata: fileMetadata,
          }, previous?.content)
          const checkpoint = async (result: Awaited<ReturnType<typeof write>>) => {
            for (const directory of missingDirectories) ownedDirectories.add(directory)
            itemMetadata[path] = {
              ...entry.metadata,
              materializedAttributes: true,
              materializedContentDigest: result.digest,
              materializedBytes: result.size || 0,
              materializedMediaType: item.mediaType,
              materializedMetadata: observableFileMetadata(fileMetadata),
            }
            await recordWorkspaceFileOwner(store, path, { workspace, source: source.key, digest: result.digest })
          }
          // Startup output needs rollback if its ownership checkpoint fails.
          // Lazy streams retain their existing streaming path without reading old bytes.
          if (source.materialize !== "startup") {
            const result = await write()
            await checkpoint(result)
            return result
          }
          return await withWorkspaceFileCheckpoint(store, path, write, checkpoint, async () => {
            if (previousItemMetadata) itemMetadata[path] = previousItemMetadata
            else delete itemMetadata[path]
          })
        }))
        sourceFiles++
        sourceBytes += written.size || 0
        persistedBytesDelta += (written.size || 0) - (tracked
          ? previousItemMetadata?.materializedBytes ?? previousStat?.size ?? (previous ? contentSize(previous.content) : 0)
          : 0)
        const contentEqual = entry.contentStream
          ? store.writeFileStream
            ? previousStat?.type === "file" && previousStat.digest !== undefined && previousStat.digest === written.storeDigest
            : written.contentEqual === true
          : previous !== undefined && contentEquals(previous.content, entry.content ?? "")
        const status = contentEqual
          && fileAttributesEqual(previous ?? previousStat ?? {}, previousItemMetadata, item.mediaType, fileMetadata)
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
      const removedDirectories = await removeStaleMaterializedSourceFiles(store, workspace, source, configuredSources, nextPaths, options, control, existing, ownedDirectories, (path, removedBytes) => {
        counts.removed++
        if (Object.hasOwn(itemMetadata, path)) persistedBytesDelta -= itemMetadata[path]?.materializedBytes ?? removedBytes
        delete itemMetadata[path]
        paths.push({ path, status: "removed" })
      })
      if (removedDirectories.has(source.mountPath)) ownsMount = false
      for (const directory of removedDirectories) ownedDirectories.delete(directory)
      const readyItems = Object.fromEntries([...nextPaths].flatMap((path) => {
        const metadata = itemMetadata[path]
        return metadata ? [[path, metadata] as const] : []
      }))

      const ready: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        ownedAncestors,
        ownedDirectories: [...ownedDirectories],
        status: "ready",
        revision,
        materializedAt: new Date().toISOString(),
        files: sourceFiles,
        bytes: sourceBytes,
        items: readyItems,
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      if (completeSource) await control.mutate(() => writeSourceSnapshotMetadata(store, workspace, ready))
      else if (existing?.configHash === configHash) {
        const scopedItems = checkpointItems(itemMetadata)
        await control.mutate(() => writeSourceSnapshotMetadata(store, workspace, {
          ...existing,
          ownsMount,
          ownedAncestors,
          ownedDirectories: [...ownedDirectories],
          bytes: Math.max(0, (existing.bytes || 0) + persistedBytesDelta),
          files: scopedItems ? Object.keys(scopedItems).length : 0,
          items: scopedItems,
        }))
      }
      else if (existing || source.materialize === "startup") {
        // Preserve ownership without reusing partial or unmigrated snapshots.
        const migratedItems = checkpointItems(itemMetadata)
        await control.mutate(() => writeSourceSnapshotMetadata(store, workspace, {
          ...ready,
          status: "updating",
          items: migratedItems,
          files: migratedItems ? Object.keys(migratedItems).length : 0,
          bytes: retainPriorItems ? Math.max(0, (existing?.bytes || 0) + persistedBytesDelta) : sourceBytes,
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
      const checkpointItemsMetadata = checkpointItems(itemMetadata)
      const resumesExistingSnapshot = existing?.configHash === configHash
      const failed: SourceSnapshotMetadata = {
        configHash,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        ownedAncestors,
        ownedDirectories: [...ownedDirectories],
        status: "error",
        revision,
        error: error instanceof Error ? error.message : String(error),
        files: resumesExistingSnapshot && checkpointItemsMetadata ? Object.keys(checkpointItemsMetadata).length : sourceFiles,
        bytes: resumesExistingSnapshot ? Math.max(0, (existing?.bytes || 0) + persistedBytesDelta) : sourceBytes,
        items: checkpointItemsMetadata,
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      const checkpoint = options.abortSignal?.aborted
        ? completeSource
          ? { ...failed, status: "updating" as const, error: undefined }
          : existing?.configHash === configHash
            ? { ...existing, ownsMount, ownedAncestors, ownedDirectories: [...ownedDirectories], items: checkpointItemsMetadata }
            : source.materialize === "startup" ? { ...failed, status: "updating" as const, error: undefined } : undefined
        : failed
      if (checkpoint && control.isCurrent()) await control.checkpoint(() => writeSourceSnapshotMetadata(store, workspace, checkpoint))
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
  previousContent?: string | Uint8Array,
): Promise<{ contentEqual?: boolean, digest?: string, storeDigest?: string, size?: number }> {
  if (file.contentStream) {
    if (store.writeFileStream) {
      let size = 0
      const hash = createHash("sha256")
      const content = (async function* () {
        for await (const chunk of contentStreamChunks(file.contentStream!)) {
          size += chunk.byteLength
          hash.update(chunk)
          yield chunk
        }
      })()
      const write = () => store.writeFileStream!(path, {
        path: file.path,
        content,
        mediaType: file.mediaType,
        metadata: file.metadata,
      })
      const written = await write()
      if (!written.digest) {
        throw workspaceError("[vitehub] Workspace Store writeFileStream() must return a content digest.")
      }
      return { digest: hash.digest("hex"), storeDigest: written.digest, size }
    }
    const content = await contentStreamToBytes(file.contentStream)
    await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
    return { contentEqual: previousContent !== undefined && contentEquals(previousContent, content), digest: await sha256(content), size: content.byteLength }
  }

  const content = file.content ?? ""
  await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
  return { digest: await sha256(content), size: contentSize(content) }
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
  const metadata: LazyMaterializedMetadata = {
    source: resolution.sourceKey,
    sourcePath: resolution.sourcePath,
    materializedAt: now,
    validatedAt: resolution.validate === "request" ? now : undefined,
    etag: readStringMeta(upstreamMeta, "etag"),
    sha: readStringMeta(upstreamMeta, "sha"),
    digest: readStringMeta(upstreamMeta, "digest") || readStringMeta(item.metadata, "digest"),
    ref: readStringMeta(upstreamMeta, "ref"),
  }
  for (const key of ["validatedAt", "etag", "sha", "digest", "ref"] as const) {
    if (metadata[key] === undefined) delete metadata[key]
  }
  return metadata
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
