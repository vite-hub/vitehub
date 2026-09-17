import { createHash } from "node:crypto"
import { posix } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { isWorkspaceConflict, workspaceError } from "../core/errors.ts"
import { contentStreamChunks, contentStreamToBytes, decodeFile, normalizeWorkspacePath, sha256 } from "../core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountContainsPath, sourceMountIntersectsPath } from "./config.ts"
import { workspaceMetadataScope } from "./workspace-metadata.ts"
import { prepareWorkspaceSource } from "./preparation.ts"
import { captureStartupPathMutations, captureStartupDirectoryRemoval, removedStartupDirectoryMetaKey } from "./startup-directory-evidence.ts"
import { normalizeSourceFileMetadata } from "./file-metadata.ts"
import { normalizeSourceItemPath, normalizeWorkspaceSourceItemPath } from "./source-items.ts"
import { searchText } from "../core/search.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { fileAttributesUnavailable } from "../internal/file-attributes.ts"
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
  WorkspaceFile,
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
  materializedContentDigest?: string
  materializedBytes?: number
  materializedMediaType?: string
  materializedMetadata?: Record<string, unknown>
}

interface SourceSnapshotMetadata extends Omit<WorkspaceSourceMaterializationStatus, "cacheStatus" | "counts" | "durationMs" | "paths" | "provider"> {
  configHash: string
  workspace?: string
  cacheMaxAge?: number
  ownsMount?: boolean
  mountIdentity?: string
  ownedAncestors?: string[]
  directoryIdentities?: Record<string, string>
  ownedDirectories?: string[]
  pendingDirectories?: string[]
  items?: Record<string, LazyMaterializedMetadata>
}

interface MaterializedStartupSource {
  key: string
  mountPath: string
}

interface PromotedSourceSkillFile {
  directoryIdentities?: Record<string, string>
  digest: string
  mediaType?: string
  metadata?: Record<string, unknown>
  source: string
  sourcePath: string
  workspace?: string
}

function startupSourcesMetaKey(workspaceName?: string) {
  return `workspace:${workspaceMetadataScope(workspaceName)}:startup-sources`
}
export function removedStartupPathMetaKey(workspaceName: string | undefined, path: string) {
  return `workspace:${workspaceMetadataScope(workspaceName)}:removed-startup-path:${JSON.stringify(path)}`
}
async function captureStartupFileRemoval(store: WorkspaceStore, path: string, source: string) {
  return { source, creationIdentity: await store.getPathCreationIdentity?.(path), mutations: await captureStartupPathMutations(store, path) }
}
export async function removedStartupFileMatches(store: WorkspaceStore, workspaceName: string | undefined, path: string, source: string) {
  if (!store.getPathCreationIdentity) return false
  return isDeepStrictEqual(await store.getMeta?.(removedStartupPathMetaKey(workspaceName, path)), await captureStartupFileRemoval(store, path, source))
}
export { removedStartupDirectoryMetaKey } from "./startup-directory-evidence.ts"
const legacyStartupSourcesMetaKey = "workspace:startup-sources"
const promotedSourceSkillsMetaKey = "workspace:promoted-source-skills"
const startupReconciliationByStore = new WeakMap<WorkspaceStore, Promise<void>>()
const activeStartupSourcesByStore = new WeakMap<WorkspaceStore, Map<string | undefined, Set<ResolvedWorkspaceSource>>>()
const promotionReconciliationByStore = new WeakMap<WorkspaceStore, Promise<void>>()

export interface MaterializationControl {
  isCurrent(): boolean
  mutate<T>(operation: () => Promise<T>): Promise<T>
  checkpoint<T>(operation: () => Promise<T>): Promise<T>
}

async function checkpointFileRemoval(store: WorkspaceStore, control: MaterializationControl, file: WorkspaceFile, checkpoint: () => Promise<void>) {
  try {
    await control.checkpoint(checkpoint)
  }
  catch (error) {
    // Restore the complete file when evidence cannot be persisted. Bypass the
    // cancelled control, but never overwrite a concurrent replacement.
    try {
      await store.writeFileConditional!(file.path, file, null)
    }
    catch (restoreError) {
      if (!isWorkspaceConflict(restoreError)) throw restoreError
    }
    throw error
  }
}

export function sourceSnapshotMetaKey(sourceKey: string, workspaceName?: string) {
  return workspaceName === undefined ? `source:${sourceKey}:snapshot` : `workspace:${JSON.stringify(workspaceName)}:source:${sourceKey}:snapshot`
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

async function readSourceSnapshotMetadata(store: Pick<WorkspaceStore, "getMeta">, sourceKey: string, workspaceName?: string) {
  // SAFETY: This private metadata key is written exclusively by writeSourceSnapshotMetadata below.
  return await store.getMeta?.(sourceSnapshotMetaKey(sourceKey, workspaceName)) as SourceSnapshotMetadata | undefined
}

export async function invalidateSourceSnapshot(store: WorkspaceStore, sourceKey: string, workspaceName?: string) {
  const snapshot = await readSourceSnapshotMetadata(store, sourceKey, workspaceName)
  // Configuration changes invalidate reuse, but old file digests still prove cleanup ownership.
  if (snapshot) await store.setMeta?.(sourceSnapshotMetaKey(sourceKey, workspaceName), { ...snapshot, status: "updating" })
}

export async function hasCurrentSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource, workspaceName?: string) {
  const configHash = await sourceConfigHash(source)
  const meta = await readSourceSnapshotMetadata(store, source.key, workspaceName)
  return meta?.status === "ready" && meta.configHash === configHash
}

export async function hasFreshSourceSnapshot(store: WorkspaceStore, source: ResolvedWorkspaceSource, workspaceName?: string) {
  const configHash = await sourceConfigHash(source)
  const snapshot = await readSourceSnapshotMetadata(store, source.key, workspaceName)
  if (!isSnapshotFresh(snapshot, source, configHash)) return false
  if (await sourceSnapshotFilesMatch(store, snapshot)) return true
  await invalidateSourceSnapshot(store, source.key, workspaceName)
  return false
}

async function sourceSnapshotFilesMatch(store: WorkspaceStore, snapshot: SourceSnapshotMetadata | undefined) {
  if (snapshot?.ownsMount && snapshot.mountPath) {
    const mount = await store.stat(snapshot.mountPath)
    if (mount?.type !== "directory" || (snapshot.mountIdentity && mount.directoryIdentity !== snapshot.mountIdentity)) return false
  }
  for (const [path, item] of Object.entries(snapshot?.items || {})) {
    let file
    try {
      file = await store.readFile(path)
    }
    catch (error) {
      const code = hasRuntimeType(error, "object") && error !== null ? Reflect.get(error, "code") : undefined
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return false
      throw error
    }
    if (!await cachedMaterializedFileMatches(file, item)) return false
  }
  return true
}

export async function readCurrentSourceSnapshot(store: Pick<WorkspaceStore, "getMeta">, source: SourceConfiguration, workspaceName?: string) {
  const configHash = await sourceConfigHash(source)
  const snapshot = await readSourceSnapshotMetadata(store, source.key, workspaceName)
  return snapshot?.configHash === configHash ? snapshot : undefined
}

export async function sourceSnapshotOwnsAnyPath(store: WorkspaceStore, sourceKey: string, paths: Iterable<string>, workspaceName?: string): Promise<boolean | undefined> {
  const meta = await readSourceSnapshotMetadata(store, sourceKey, workspaceName)
  if (!meta || meta.status !== "ready") return undefined
  const ownedPaths = new Set(Object.keys(meta.items || {}))
  return [...paths].some(path => ownedPaths.has(normalizeWorkspacePath(path)))
}

async function writeSourceSnapshotMetadata(store: WorkspaceStore, metadata: SourceSnapshotMetadata) {
  await store.setMeta?.(sourceSnapshotMetaKey(metadata.source, metadata.workspace), metadata)
}

const sourceSkillRoots = [".agents", ".claude", ".codex"] as const

function sourceSkillPromotion(path: string, mountPath: string): { destination: string, root: typeof sourceSkillRoots[number], skill: string } | undefined {
  const prefix = normalizeWorkspacePath(mountPath)
  const relative = prefix ? (path === prefix ? "" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined) : path
  if (relative === undefined) return
  const match = relative.match(/^(\.agents|\.claude|\.codex)\/skills\/(.+)$/)
  if (!match) return
  // SAFETY: The regular expression capture is one of the known source skill roots.
  const root = match[1] as typeof sourceSkillRoots[number]
  if (!root) return
  const skillPath = match[2]
  const [skill, ...rest] = skillPath.split("/")
  if (!skill || !/^[a-z0-9][a-z0-9-]*$/.test(skill) || !rest.length) return
  return { destination: `.agents/skills/${skill}/${rest.join("/")}`, root, skill }
}

function isPromotedSourceSkillFile(value: unknown): value is PromotedSourceSkillFile {
  return hasRuntimeType(value, "object") && value !== null
    && hasRuntimeType(Reflect.get(value, "digest"), "string")
    && hasRuntimeType(Reflect.get(value, "source"), "string")
    && hasRuntimeType(Reflect.get(value, "sourcePath"), "string")
}

async function promotedFileMatches(file: WorkspaceFile, prior: PromotedSourceSkillFile) {
  const legacy = !Object.hasOwn(prior, "mediaType") && !Object.hasOwn(prior, "metadata")
  return await sha256(file.content) === prior.digest
    && (legacy || fileAttributesUnavailable(file) || (file.mediaType === prior.mediaType
      && isDeepStrictEqual(observableFileMetadata(file.metadata), observableFileMetadata(prior.metadata))))
}

export async function readGeneratedPromotedSkillPaths(store: WorkspaceStore, sources: readonly ResolvedWorkspaceSource[], workspaceName?: string) {
  const registry = await store.getMeta?.(`${promotedSourceSkillsMetaKey}:${workspaceMetadataScope(workspaceName)}`)
  const paths = { files: new Set<string>(), directories: new Set<string>() }
  if (!hasRuntimeType(registry, "object") || registry === null) return paths
  const startupSources = new Set(sources.filter(source => source.materialize === "startup").map(source => source.key))
  for (const [path, prior] of Object.entries(registry)) {
    if (!isPromotedSourceSkillFile(prior) || prior.workspace !== workspaceName || !startupSources.has(prior.source)) continue
    const file = await readSourceFile(store, path)
    if (file && await promotedFileMatches(file, prior)) {
      paths.files.add(path)
      for (const [directory, identity] of Object.entries(prior.directoryIdentities || {})) {
        if ((await store.stat(directory))?.directoryIdentity === identity) paths.directories.add(directory)
      }
    }
  }
  return paths
}

async function readSourceFile(store: WorkspaceStore, path: string) {
  try { return await store.readFile(path) }
  catch (error) {
    if (hasRuntimeType(error, "object") && error !== null && (Reflect.get(error, "code") === "EISDIR" || Reflect.get(error, "code") === "ENOTDIR")) return undefined
    throw error
  }
}

async function hasNonFilePromotionDestination(store: WorkspaceStore, path: string) {
  try {
    const stat = await store.stat(path)
    if (stat?.type === "directory") return true
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
      if ((await store.stat(parent))?.type === "file") return true
    }
    return false
  }
  catch (error) {
    if (hasRuntimeType(error, "object") && error !== null && Reflect.get(error, "code") === "ENOTDIR") return true
    throw error
  }
}

async function reconcilePromotedSourceSkills(
  store: WorkspaceStore,
  sources: readonly ResolvedWorkspaceSource[],
  control: MaterializationControl,
  workspaceName?: string,
) {
  if (!store.getMeta || !store.setMeta || !store.writeFileConditional) return
  const writeFileConditional = store.writeFileConditional.bind(store)
  const pendingDirectoryMetaKey = (destination: string) => `workspace:${workspaceMetadataScope(workspaceName)}:pending-promoted-skill-directories:${JSON.stringify(destination)}`
  const completedDirectoryCheckpoints = new Set<string>()
  const previousValue = await store.getMeta(`${promotedSourceSkillsMetaKey}:${workspaceMetadataScope(workspaceName)}`)
  const previous = hasRuntimeType(previousValue, "object") && previousValue !== null
    ? Object.fromEntries(Object.entries(previousValue).filter((entry): entry is [string, PromotedSourceSkillFile] => isPromotedSourceSkillFile(entry[1])))
    : {}
  const incompleteSources = new Set<string>()
  const selectedSkills = new Map<string, { paths: string[], source: string }>()
  // Keep promotion aligned with Workspace source precedence: more-specific
  // mounts win, with the source key only breaking ties.
  const verifiedSkillFiles = new Map<string, WorkspaceFile>()
  const sortedSources = [...sources].sort((left, right) =>
    right.mountPath.length - left.mountPath.length || left.key.localeCompare(right.key))
  for (const source of sortedSources) {
    const snapshot = await readSourceSnapshotMetadata(store, source.key, workspaceName)
    if (snapshot && snapshot.status === "ready") {
      const currentHash = await sourceConfigHash(source)
      if (snapshot.configHash !== currentHash) continue
    }
    if (!snapshot || snapshot.status !== "ready") {
      incompleteSources.add(source.key)
      continue
    }
    const verifiedFiles = new Map<string, WorkspaceFile>()
    let complete = true
    for (const [path, item] of Object.entries(snapshot.items || {})) {
      if (!sourceSkillPromotion(path, source.mountPath)) continue
      const file = await readSourceFile(store, path)
      if (!file || !await materializedFileMatches(file, item)) {
        complete = false
        break
      }
      verifiedFiles.set(path, file)
    }
    if (!complete) {
      incompleteSources.add(source.key)
      continue
    }
    for (const [path, file] of verifiedFiles) verifiedSkillFiles.set(path, file)
    const pathsBySkill = new Map<string, Map<typeof sourceSkillRoots[number], string[]>>()
    for (const sourcePath of Object.keys(snapshot.items || {}).sort()) {
      const promotion = sourceSkillPromotion(sourcePath, source.mountPath)
      if (!promotion) continue
      const pathsByRoot = pathsBySkill.get(promotion.skill) || new Map()
      const paths = pathsByRoot.get(promotion.root) || []
      paths.push(sourcePath)
      pathsByRoot.set(promotion.root, paths)
      pathsBySkill.set(promotion.skill, pathsByRoot)
    }
    for (const [skill, pathsByRoot] of pathsBySkill) {
      if (selectedSkills.has(skill)) continue
      const paths = sourceSkillRoots.map(root => pathsByRoot.get(root)).find(candidate => candidate?.some(path => path.endsWith("/SKILL.md")))
      if (paths) selectedSkills.set(skill, { paths, source: source.key })
    }
  }

  const candidates = new Map<string, { source: string, sourcePath: string, skill: string }>()
  const retainedSkills = new Set<string>()
  for (const [skill, selected] of selectedSkills) {
    const rootSkillPath = `.agents/skills/${skill}/SKILL.md`
    const existingRootSkill = await readSourceFile(store, rootSkillPath)
    const previousRootSkill = previous[rootSkillPath]
    const ownsRootSkill = Boolean(previousRootSkill && existingRootSkill && await promotedFileMatches(existingRootSkill, previousRootSkill))
    if ((existingRootSkill && !ownsRootSkill) || await hasNonFilePromotionDestination(store, rootSkillPath)) {
      retainedSkills.add(skill)
      continue
    }
    for (const sourcePath of selected.paths) {
      const promotion = sourceSkillPromotion(sourcePath, sortedSources.find(source => source.key === selected.source)?.mountPath || "")
      if (!promotion || sourcePath === promotion.destination) continue
      candidates.set(promotion.destination, { source: selected.source, sourcePath, skill })
    }
  }
  for (const [path, prior] of Object.entries(previous)) {
    if (!path.includes("/skills/")) continue
    const destinationMatch = path.match(/^\.agents\/skills\/([^/]+)\//)
    if (!destinationMatch) continue
    const existing = await readSourceFile(store, path)
    if (existing && !await promotedFileMatches(existing, prior)) retainedSkills.add(destinationMatch[1])
  }

  // Validate the complete Skill before updating any of its files.
  for (const [destination, candidate] of candidates) {
    const existing = await readSourceFile(store, destination)
    const prior = previous[destination]
    const ownsExisting = Boolean(prior && prior.workspace === workspaceName && existing && await promotedFileMatches(existing, prior))
    // Digest-only writes cannot protect an existing file's metadata or media type.
    if ((existing && (!ownsExisting || !store.compareAndSwapFile)) || await hasNonFilePromotionDestination(store, destination)) retainedSkills.add(candidate.skill)
  }

  const next: Record<string, PromotedSourceSkillFile> = Object.fromEntries(Object.entries(previous).filter(([path, prior]) => {
    const destinationMatch = path.match(/^\.agents\/skills\/([^/]+)\//)
    return incompleteSources.has(prior.source) || (destinationMatch && retainedSkills.has(destinationMatch[1]))
  }))
  for (const [skill] of selectedSkills) {
    if (retainedSkills.has(skill)) continue
    const entries = [...candidates].filter(([, candidate]) => candidate.skill === skill)
    const writes: { destination: string, existing: WorkspaceFile | undefined, promoted: PromotedSourceSkillFile }[] = []
    let conflicted = false
    let failure: unknown
    // Multiple writes require compensation that also checks file attributes.
    if (entries.length > 1 && !store.compareAndSwapFile) conflicted = true
    for (const [destination, candidate] of entries) {
      if (conflicted) break
      const sourceFile = verifiedSkillFiles.get(candidate.sourcePath)
      const existing = await readSourceFile(store, destination)
      const prior = previous[destination]
      const ownsExisting = Boolean(prior && prior.workspace === workspaceName && existing && await promotedFileMatches(existing, prior))
      if (!sourceFile || (existing && !ownsExisting) || (entries.length > 1 && !store.compareAndSwapFile) || await hasNonFilePromotionDestination(store, destination)) {
        conflicted = true
        break
      }
      const metadata = {
        ...sourceFile.metadata,
        promotedSourceSkill: { source: candidate.source, sourcePath: candidate.sourcePath },
      }
      const pendingDirectories = await store.getMeta(pendingDirectoryMetaKey(destination))
      const directoryIdentities = { ...prior?.directoryIdentities }
      if (hasRuntimeType(pendingDirectories, "object") && pendingDirectories !== null) {
        for (const [path, identity] of Object.entries(pendingDirectories)) {
          if (hasRuntimeType(identity, "string")) directoryIdentities[path] = identity
        }
      }
      const promoted = { directoryIdentities, source: candidate.source, sourcePath: candidate.sourcePath, digest: await sha256(sourceFile.content), mediaType: sourceFile.mediaType, metadata: observableFileMetadata(metadata), workspace: workspaceName }
      const expectedDigest = existing ? await sha256(existing.content) : null
      try {
        await control.mutate(async () => {
          try {
            await store.mkdir(posix.dirname(destination), { recursive: true, onCreate: (path, identity) => {
              if (identity) directoryIdentities[path] = identity
            } })
          }
          finally {
            // Directory creation survives failed or compensated file writes.
            // Keep its evidence until the promotion registry is committed.
            await store.setMeta!(pendingDirectoryMetaKey(destination), directoryIdentities)
          }
          const replacement = { ...sourceFile, path: destination, metadata }
          if (existing && store.compareAndSwapFile) await store.compareAndSwapFile(destination, existing, replacement)
          else await writeFileConditional(destination, replacement, expectedDigest)
        })
        writes.push({ destination, existing, promoted })
      }
      catch (error) {
        if (!isWorkspaceConflict(error)) {
          const code = hasRuntimeType(error, "object") && error !== null ? Reflect.get(error, "code") : undefined
          if (code !== "EISDIR" && code !== "ENOTDIR") failure = error
        }
        conflicted = true
      }
    }
    if (conflicted) {
      for (const { destination, existing, promoted } of writes.reverse()) {
        const current = await readSourceFile(store, destination)
        if (!current || !await promotedFileMatches(current, promoted)) continue
        try {
          // Compensate committed writes even after cancellation or supersession.
          // Bind the mutation to the complete file read above, including ownership.
          await store.compareAndSwapFile?.(destination, current, existing)
        }
        catch (error) {
          if (!isWorkspaceConflict(error)) throw error
        }
      }
      for (const [destination, prior] of Object.entries(previous)) {
        if (destination.startsWith(`.agents/skills/${skill}/`)) next[destination] = prior
      }
    }
    else {
      for (const { destination, promoted } of writes) {
        next[destination] = promoted
        completedDirectoryCheckpoints.add(destination)
      }
    }
    if (failure) throw failure
  }
  for (const [destination, prior] of Object.entries(previous)) {
    if (next[destination]) continue
    const existing = await readSourceFile(store, destination)
    if (existing && await promotedFileMatches(existing, prior)) {
      const latest = await readSourceFile(store, destination)
      if (latest && await promotedFileMatches(latest, prior)) {
        if (store.compareAndSwapFile && (latest.metadata?.sourceMaterialize !== "startup" || store.getPathCreationIdentity)) {
          const removalEvidence = latest.metadata?.sourceMaterialize === "startup"
            ? await captureStartupFileRemoval(store, destination, prior.source)
            : undefined
          try {
            await control.mutate(() => store.compareAndSwapFile!(destination, latest, undefined))
          }
          catch (error) {
            if (!isWorkspaceConflict(error)) throw error
            next[destination] = prior
            continue
          }
          if (removalEvidence) {
            await checkpointFileRemoval(store, control, latest, async () => {
              const removed = !await store.stat(destination)
              await store.setMeta?.(removedStartupPathMetaKey(workspaceName, destination), removed ? removalEvidence : null)
            })
          }
        }
        else {
          // Without complete-file conditional removal, retain the entry rather than
          // risking deletion of a concurrent user replacement.
          next[destination] = prior
        }
        // Retain promoted directories: conditional file removal cannot bind
        // directory removal to its observed identity and emptiness.
      }
    }
    else if (existing) next[destination] = prior
  }
  await control.checkpoint(async () => await store.setMeta?.(`${promotedSourceSkillsMetaKey}:${workspaceMetadataScope(workspaceName)}`, next))
  await control.checkpoint(async () => {
    for (const destination of completedDirectoryCheckpoints) await store.setMeta?.(pendingDirectoryMetaKey(destination), null)
  })
}

function materializedItemMeta(
  snapshot: SourceSnapshotMetadata | undefined,
  configHash: string,
  path: string,
) {
  if (!snapshot) return undefined
  // An indexed item from another configuration is cleanup evidence only. It
  // must never satisfy a lazy read for the current definition.
  if (snapshot.configHash !== configHash) return undefined
  if (snapshot.status !== "ready" && snapshot.status !== "updating" && snapshot.status !== "error") return undefined
  return snapshot.items?.[path]
}

function checkpointItems(items: Record<string, LazyMaterializedMetadata>) {
  return Object.keys(items).length ? items : undefined
}

export async function materializedFileMatches(file: Awaited<ReturnType<WorkspaceStore["readFile"]>>, item: LazyMaterializedMetadata) {
  if (!file || !item.materializedContentDigest) return false
  if (await sha256(file.content) !== item.materializedContentDigest) return false
  if (!item.materializedAttributes || fileAttributesUnavailable(file)) return true
  if (file.metadata === undefined) return false
  return file.mediaType === item.materializedMediaType
    && isDeepStrictEqual(observableFileMetadata(file.metadata), observableFileMetadata(item.materializedMetadata))
}

// Snapshot ownership remains useful after sidecar loss, but cache reuse must
// prove that the recorded attributes are still visible before skipping replay.
async function cachedMaterializedFileMatches(file: Awaited<ReturnType<WorkspaceStore["readFile"]>>, item: LazyMaterializedMetadata) {
  if (file && item.materializedAttributes && fileAttributesUnavailable(file)) return false
  return materializedFileMatches(file, item)
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
  if (previousSnapshot?.materializedMetadata !== undefined) {
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
  source: ResolvedWorkspaceSource,
  sources: ResolvedWorkspaceSource[],
  nextPaths: Set<string>,
  scope: WorkspaceMaterializeSourcesOptions | undefined,
  control: MaterializationControl,
  previousSnapshot: SourceSnapshotMetadata | undefined,
  workspaceName: string | undefined,
  onRemoved?: (path: string, bytes: number) => void,
  onPendingDirectories?: (paths: string[]) => void,
) {
  if (!store.conditionalRemoval) return new Set<string>()
  const previousPaths = new Set(Object.keys(previousSnapshot?.items || {}))
  const nextDirectories = new Set([...nextPaths].flatMap(path => parentDirectoryPaths(path)))
  const staleDirectories = new Set(previousSnapshot?.pendingDirectories || [])
  const removedDirectories = new Set<string>()
  let cleanupBaseline: Promise<string | undefined> | undefined
  // Build cleanup leaves an empty snapshot object; only that missing index needs recovery.
  // With metadata support, an absent snapshot is a first startup with no owned paths.
  const entries = source.mountPath
    ? await store.list(source.mountPath, { recursive: true })
    : previousPaths.size || (store.getMeta && store.setMeta && (!previousSnapshot || previousSnapshot.items))
      ? await Promise.all([...previousPaths].map(async path => await store.stat(path)))
      : await store.list("", { recursive: true })
  for (const entry of entries) {
    if (!entry || !materializationPathMatches(entry.path, scope) || nextPaths.has(entry.path) || entry.type !== "file") continue
    const file = await store.readFile(entry.path)
    const currentOwner = file?.metadata?.source
    if (file?.metadata?.workspace !== undefined && file.metadata.workspace !== workspaceName) continue
    if (source.materialize === "startup" && previousSnapshot?.configHash && !previousPaths.has(entry.path)) continue
    if ((currentOwner === undefined || source.materialize === "startup") && previousSnapshot?.items) {
      // Persisted ownership can survive a user edit made outside the Store.
      // Only remove indexed startup files while their materialized content matches.
      const recorded = previousSnapshot.items[entry.path]
      if (!file || (recorded?.materializedContentDigest && !await materializedFileMatches(file, recorded))
        || (recorded?.materializedAttributes && currentOwner === undefined && !fileAttributesUnavailable(file))
        || (!recorded?.materializedContentDigest && currentOwner !== source.key)) continue
    }
    const overlapsAnotherSource = sources.some(candidate =>
      candidate.key !== source.key
      && candidate.mountPath.length >= source.mountPath.length
      && sourceMountContainsPath(candidate, entry.path),
    )
    if (currentOwner === source.key || (currentOwner === undefined && (previousPaths.has(entry.path) || (Boolean(source.mountPath) && !overlapsAnotherSource)))) {
      for (const directory of parentDirectoryPaths(entry.path)) {
        if (sourceOwnsDirectory(source, directory)
          && (directory === source.mountPath ? previousSnapshot?.ownsMount : previousSnapshot?.ownedDirectories?.includes(directory) || !store.getMeta || !store.setMeta)) staleDirectories.add(directory)
      }
      onPendingDirectories?.([...staleDirectories])
      for (const candidate of sources) {
        if (candidate.key === source.key) continue
        const retainedSnapshot = await readSourceSnapshotMetadata(store, candidate.key, workspaceName)
        if (retainedSnapshot?.status !== "ready" || !retainedSnapshot.items?.[entry.path]) continue
        await control.checkpoint(() => writeSourceSnapshotMetadata(store, { ...retainedSnapshot, status: "updating" }))
      }
      // Re-read immediately before removal so edits made while checkpointing
      // are treated as explicit ownership and never deleted.
      const latest = await store.readFile(entry.path)
      if (!latest) continue
      const latestOwner = latest.metadata?.source
      if (latest.metadata?.workspace !== undefined && latest.metadata.workspace !== workspaceName) continue
      if (latestOwner !== undefined && latestOwner !== source.key) continue
      if ((latestOwner === undefined || source.materialize === "startup") && previousSnapshot?.items?.[entry.path]) {
        const recorded = previousSnapshot.items[entry.path]
        if (!await materializedFileMatches(latest, recorded)
          || (recorded.materializedAttributes && latestOwner === undefined && !fileAttributesUnavailable(latest))) continue
      }
      // Digest and ownership conditions cannot detect concurrent attribute edits.
      if (!store.compareAndSwapFile || !store.writeFileConditional || (source.materialize === "startup" && !store.getPathCreationIdentity)) continue
      const removalEvidence = await captureStartupFileRemoval(store, entry.path, source.key)
      try {
        await control.mutate(() => store.compareAndSwapFile!(entry.path, latest, undefined))
      }
      catch (error) {
        if (!isWorkspaceConflict(error)) throw error
        if (source.materialize === "startup") {
          await control.checkpoint(async () => await store.setMeta?.(removedStartupPathMetaKey(workspaceName, entry.path), null))
        }
        continue
      }
      if (source.materialize === "startup") {
        await checkpointFileRemoval(store, control, latest, async () => {
          const removed = !await store.stat(entry.path)
          await store.setMeta?.(removedStartupPathMetaKey(workspaceName, entry.path), removed ? removalEvidence : null)
        })
      }
      onRemoved?.(entry.path, file ? contentSize(file.content) : 0)
    }
  }
  const pendingDirectories = [...staleDirectories].filter(path => !nextDirectories.has(path))
  onPendingDirectories?.(pendingDirectories)
  for (const path of pendingDirectories.sort((a, b) => b.length - a.length)) {
    try {
      const baseline = source.materialize === "startup"
        ? await (cleanupBaseline ??= store.diff().then(diff => diff.from))
        : undefined
      const removalEvidence = await captureStartupDirectoryRemoval(store, path, baseline)
      const stat = await store.stat(path)
      if (stat?.type !== "directory") continue
      const ownedIdentity = path === source.mountPath ? previousSnapshot?.mountIdentity : previousSnapshot?.directoryIdentities?.[path]
      if (!ownedIdentity || stat.directoryIdentity !== ownedIdentity) continue
      // A stat followed by unconditional rm can delete a concurrent replacement.
      if (!store.conditionalDirectoryRemoval || !stat.directoryIdentity) continue
      if ((await store.list(path)).length) continue
      await control.mutate(() => store.rm(path, { force: true, ifDirectoryIdentity: stat.directoryIdentity }))
      if (!await store.stat(path)) {
        removedDirectories.add(path)
        if (source.materialize === "startup") {
          await control.checkpoint(async () => await store.setMeta?.(removedStartupDirectoryMetaKey(workspaceName, path), removalEvidence))
        }
      }
    }
    catch (error) {
      if (!hasRuntimeType(error, "object") || error === null || !["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(Reflect.get(error, "code"))) throw error
    }
  }
  return removedDirectories
}

export async function reconcileRemovedStartupSources(
  store: WorkspaceStore,
  currentSources: ResolvedWorkspaceSource[],
  control: MaterializationControl = {
    isCurrent: () => true,
    async mutate(operation) { return await operation() },
    async checkpoint(operation) { return await operation() },
  },
  materializationStore = store,
  workspaceName?: string,
) {
  // Per-source materializations share removed owners, so finish their cleanup
  // before another source can observe and delete the same files.
  const previous = startupReconciliationByStore.get(materializationStore)
  const current = (async () => {
    await previous
    await reconcileRemovedStartupSourcesInternal(store, currentSources, control, activeStartupSourcesByStore.get(materializationStore)?.get(workspaceName), workspaceName)
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
  store: WorkspaceStore,
  currentSources: ResolvedWorkspaceSource[],
  control: MaterializationControl,
  activeSources: Set<ResolvedWorkspaceSource> = new Set(),
  workspaceName?: string,
) {
  if (!store.getMeta || !store.setMeta) return
  let value = await store.getMeta(startupSourcesMetaKey(workspaceName))
  // Older releases used an unscoped registry. It is safe to consider that
  // history only for the default workspace; named workspaces must never
  // inherit another workspace's ownership evidence.
  if (value === undefined && workspaceName === undefined) {
    value = await store.getMeta(legacyStartupSourcesMetaKey)
    if (value !== undefined) {
      await store.setMeta(startupSourcesMetaKey(workspaceName), value)
      await store.setMeta(legacyStartupSourcesMetaKey, null)
    }
  }
  let cleanupBaseline: Promise<string | undefined> | undefined
  const previousSources = Array.isArray(value) ? value.filter(isMaterializedStartupSource) : []
  const currentMounts = new Map(currentSources.map(source => [source.key, source.mountPath]))
  const activeOwners = [...activeSources]
  const isActive = (source: MaterializedStartupSource) => activeOwners.some(active => active.key === source.key && active.mountPath === source.mountPath)
  for (const source of previousSources.filter(source => currentMounts.get(source.key) !== source.mountPath && !isActive(source))) {
    const snapshot = await readSourceSnapshotMetadata(store, source.key, workspaceName)
    const invalidatedSnapshot = snapshot && snapshot.mountPath === undefined && snapshot.items === undefined
    if (snapshot?.mountPath !== source.mountPath && !invalidatedSnapshot) continue
    // Build synchronization can clear the index while owned files remain outside its mount.
    const previousPaths = invalidatedSnapshot
      ? (await store.list(source.mountPath, { recursive: true })).filter(entry => entry.type === "file").map(entry => entry.path)
      : Object.keys(snapshot?.items || {})
    const staleDirectories = new Set([...(snapshot?.ownedAncestors || []), ...(snapshot?.ownedDirectories || []).filter(path => sourceOwnsDirectory(source, path))])
    if (source.mountPath && snapshot?.ownsMount) staleDirectories.add(source.mountPath)
    for (const path of previousPaths) {
      if (!store.conditionalRemoval) continue
      const file = await readSourceFile(store, path)
      if (!file) continue
      const owner = file.metadata?.source
      if (file.metadata?.workspace !== undefined && file.metadata.workspace !== workspaceName) continue
      const recorded = snapshot?.items?.[path]
      const recordedDigest = recorded?.materializedContentDigest
      // Missing legacy attributes permit digest ownership. An observable owner
      // removal or attribute change releases the current file to the user.
      const removalKey = removedStartupPathMetaKey(workspaceName, path)
      if ((recorded?.materializedContentDigest && !await materializedFileMatches(file, recorded))
        || (recorded?.materializedAttributes && owner === undefined && !fileAttributesUnavailable(file))
        || (owner !== source.key && !(owner === undefined && recordedDigest))) {
        await control.checkpoint(async () => await store.setMeta?.(removalKey, null))
        continue
      }
      for (const currentSource of currentSources) {
        const retainedSnapshot = await readSourceSnapshotMetadata(store, currentSource.key, workspaceName)
        if (retainedSnapshot?.status !== "ready" || !retainedSnapshot.items?.[path]) continue
        await control.checkpoint(() => writeSourceSnapshotMetadata(store, { ...retainedSnapshot, status: "updating" }))
      }
      if (!store.compareAndSwapFile || !store.writeFileConditional || !store.getPathCreationIdentity) continue
      const removalEvidence = await captureStartupFileRemoval(store, path, source.key)
      try {
        await control.mutate(() => store.compareAndSwapFile!(path, file, undefined))
      }
      catch (error) {
        if (!isWorkspaceConflict(error)) throw error
        await control.checkpoint(async () => await store.setMeta?.(removalKey, null))
        continue
      }
      // Preserve cleanup evidence after the Source snapshot is retired. A
      // conditional removal can leave a concurrent replacement untouched.
      await checkpointFileRemoval(store, control, file, async () => {
        const removed = !await store.stat(path)
        await store.setMeta?.(removalKey, removed ? removalEvidence : null)
      })
    }
    for (const path of [...staleDirectories].sort((a, b) => b.length - a.length)) {
      const baseline = await (cleanupBaseline ??= store.diff().then(diff => diff.from))
      const removalEvidence = await captureStartupDirectoryRemoval(store, path, baseline)
      // A replaced ancestor can also make stat fail with ENOTDIR. Neither case
      // provides current directory evidence for cleanup or ownership transfer.
      const stat = await store.stat(path).catch((error) => {
        if (hasRuntimeType(error, "object") && error !== null && ["ENOENT", "ENOTDIR"].includes(Reflect.get(error, "code"))) return undefined
        throw error
      })
      if (stat?.type !== "directory") continue
      const ownedIdentity = path === source.mountPath ? snapshot?.mountIdentity : snapshot?.directoryIdentities?.[path]
      if (!ownedIdentity || stat.directoryIdentity !== ownedIdentity) continue
      for (const currentSource of currentSources) {
        if (!pathContains(path, currentSource.mountPath) && !pathContains(currentSource.mountPath, path)) continue
        const retainedSnapshot = await readSourceSnapshotMetadata(store, currentSource.key, workspaceName)
        if (retainedSnapshot?.mountPath !== currentSource.mountPath) continue
        // Retained files can keep this directory nonempty. Carry its ownership
        // forward even when the removal below cannot delete the shared mount.
        await control.checkpoint(() => writeSourceSnapshotMetadata(store, {
          ...retainedSnapshot,
          ...(path === currentSource.mountPath
            ? path === source.mountPath && snapshot?.ownsMount ? { ownsMount: true, mountIdentity: ownedIdentity } : {}
            : {
                ...(pathContains(currentSource.mountPath, path)
                  ? { ownedDirectories: [...new Set([...(retainedSnapshot.ownedDirectories || []), path])] }
                  : { ownedAncestors: [...new Set([...(retainedSnapshot.ownedAncestors || []), path])] }),
                directoryIdentities: { ...retainedSnapshot.directoryIdentities, [path]: ownedIdentity },
              }),
        }))
      }
      if (!store.conditionalDirectoryRemoval || !stat.directoryIdentity) continue
      if ((await store.list(path)).length) continue
      try {
        await control.mutate(() => store.rm(path, { force: true, ifDirectoryIdentity: stat.directoryIdentity }))
        if (!await store.stat(path)) {
          await control.checkpoint(async () => await store.setMeta?.(removedStartupDirectoryMetaKey(workspaceName, path), removalEvidence))
        }
      }
      catch (error) {
        if (!hasRuntimeType(error, "object") || error === null || !["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(Reflect.get(error, "code"))) throw error
      }
    }
    await control.checkpoint(async () => await store.setMeta?.(sourceSnapshotMetaKey(source.key, workspaceName), {}))
  }
  // Register before materialization can persist files, including failed or interrupted attempts.
  // A newer definition must retain owners that can still write or checkpoint files.
  const trackedSources = [...currentSources, ...activeOwners, ...previousSources.filter(isActive)]
  const uniqueSources = trackedSources.filter((source, index) => trackedSources.findIndex(candidate => candidate.key === source.key && candidate.mountPath === source.mountPath) === index)
  await control.checkpoint(async () => await store.setMeta?.(startupSourcesMetaKey(workspaceName), uniqueSources.map(({ key, mountPath }) => ({ key, mountPath }))))
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
  // Validate descriptors before reading digest/etag fields, which may be accessors.
  item = { ...item, metadata: normalizeSourceFileMetadata(item.metadata || {}) }
  upstreamMeta = upstreamMeta && normalizeSourceFileMetadata(upstreamMeta)
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
      if (stat?.type === "file" && await cachedMaterializedFileMatches(await store.readFile(path), previous)) {
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
  const workspaceSources = activeStartupSourcesByStore.get(store) ?? new Map<string | undefined, Set<ResolvedWorkspaceSource>>()
  const activeSources = workspaceSources.get(definition.name) ?? new Set<ResolvedWorkspaceSource>()
  const selectedSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "startup" && shouldMaterializeSource(source, options))
  for (const source of selectedSources) activeSources.add(source)
  workspaceSources.set(definition.name, activeSources)
  activeStartupSourcesByStore.set(store, workspaceSources)
  try {
    return await materializeWorkspaceSourcesInternal(definition, store, options, control)
  }
  finally {
    for (const source of selectedSources) activeSources.delete(source)
    if (!activeSources.size) workspaceSources.delete(definition.name)
    if (!workspaceSources.size) activeStartupSourcesByStore.delete(store)
  }
}

async function materializeWorkspaceSourcesInternal(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  options: WorkspaceMaterializeSourcesOptions,
  control: MaterializationControl,
): Promise<WorkspaceMaterializeSourcesResult> {
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
    await reconcileRemovedStartupSources(store, startupSources, control, store, definition.name)
  }
  const resultSources: WorkspaceSourceMaterializationStatus[] = []
  let files = 0
  let directories = 0
  let bytes = 0

  // Materialize lower-priority sources first so earlier normalized sources
  // retain deterministic precedence when mounts overlap.
  for (const source of [...sources].reverse()) {
    throwIfAborted(options.abortSignal)
    const sourceStarted = Date.now()
    await reportMaterializationProgress(options, source, { status: "started" })
    let configHash: string
    let existing: SourceSnapshotMetadata | undefined
    const completeSource = materializesCompleteSource(source, options)
    let cacheHit: boolean
    try {
      configHash = await sourceConfigHash(source)
      existing = await readSourceSnapshotMetadata(store, source.key, definition.name)
      cacheHit = completeSource && isSnapshotFresh(existing, source, configHash) && await sourceSnapshotFilesMatch(store, existing)
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
    let mountIdentity = existing?.mountPath === source.mountPath ? existing.mountIdentity : undefined
    const ownedAncestors = new Set(existing?.mountPath === source.mountPath ? existing.ownedAncestors : [])
    const directoryIdentities = { ...(existing?.mountPath === source.mountPath ? existing.directoryIdentities : undefined) }
    const ownedDirectories = new Set(existing?.mountPath === source.mountPath ? existing.ownedDirectories : [])
    let pendingDirectories = existing?.pendingDirectories
    let revision = existing?.revision
    const retainPriorItems = existing?.configHash === configHash
      || source.materialize === "startup" && existing?.mountPath === source.mountPath
    const itemMetadata: Record<string, LazyMaterializedMetadata> = retainPriorItems
      ? { ...existing?.items }
      : {}
    if (completeSource) {
      assertCurrent()
      await control.mutate(() => writeSourceSnapshotMetadata(store, {
        configHash,
        workspace: definition.name,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        mountIdentity,
        ownedAncestors: [...ownedAncestors],
        ownedDirectories: [...ownedDirectories],
        directoryIdentities,
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
          await store.mkdir(source.mountPath, { recursive: true, onCreate: (path, identity) => {
            if (path === source.mountPath) {
              ownsMount = true
              mountIdentity = identity
            }
            else {
              ownedAncestors.add(path)
              if (identity) directoryIdentities[path] = identity
            }
          } })
        })
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
        const metadata = normalizeSourceFileMetadata(item.metadata || {})
        const previousStat = await store.stat(path)
        const previous = entry.contentStream && store.writeFileStream ? undefined : await store.readFile(path)
        const previousExists = previousStat?.type === "file" || Boolean(previous)
        const fileMetadata = normalizeSourceFileMetadata({
          ...metadata,
          ...entry.metadata,
          source: source.key,
          workspace: definition.name,
          sourceMaterialize: source.materialize,
        })
        const written = await writeMaterializedFile(store, path, {
          path,
          content: entry.content,
          contentStream: entry.contentStream,
          mediaType: item.mediaType,
          metadata: fileMetadata,
        }, {
          ...control,
          mutate: operation => control.mutate(async () => {
            // Claim only directories created by this mutation, including parents
            // created before a write fails. A prior stat cannot prove ownership.
            const parent = posix.dirname(path)
            if (parent !== ".") await store.mkdir(parent, { recursive: true, onCreate: (directory, identity) => {
              if (directory === source.mountPath || !sourceOwnsDirectory(source, directory)) return
              ownedDirectories.add(directory)
              if (identity) directoryIdentities[directory] = identity
            } })
            return await operation()
          }),
        }, previous?.content)
        if (source.materialize === "startup") {
          await control.checkpoint(async () => await store.setMeta?.(removedStartupPathMetaKey(definition.name, path), null))
        }
        const tracked = Object.hasOwn(itemMetadata, path)
        const previousItemMetadata = itemMetadata[path]
        // Stores may omit file attributes. Record only attributes that can be
        // read back, so missing Local Store sidecars still invalidate reuse.
        const stored = await store.stat(path)
        itemMetadata[path] = {
          ...entry.metadata,
          materializedAttributes: stored?.metadata !== undefined ? true : undefined,
          materializedContentDigest: written.contentDigest ?? written.digest,
          materializedBytes: written.size || 0,
          materializedMediaType: item.mediaType,
          materializedMetadata: observableFileMetadata(fileMetadata),
        }
        sourceFiles++
        sourceBytes += written.size || 0
        persistedBytesDelta += (written.size || 0) - (tracked
          ? previousItemMetadata?.materializedBytes ?? previousStat?.size ?? (previous ? contentSize(previous.content) : 0)
          : 0)
        const contentEqual = entry.contentStream
          ? store.writeFileStream
            ? previousStat?.type === "file" && previousStat.digest !== undefined && previousStat.digest === written.digest
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
      const removedDirectories = await removeStaleMaterializedSourceFiles(store, source, configuredSources, nextPaths, options, control, existing, definition.name, (path, removedBytes) => {
        counts.removed++
        if (Object.hasOwn(itemMetadata, path)) persistedBytesDelta -= itemMetadata[path]?.materializedBytes ?? removedBytes
        delete itemMetadata[path]
        paths.push({ path, status: "removed" })
      }, (paths) => { pendingDirectories = paths })
      if (removedDirectories.has(source.mountPath)) ownsMount = false
      for (const directory of removedDirectories) {
        ownedDirectories.delete(directory)
        delete directoryIdentities[directory]
      }
      const readyItems = Object.fromEntries([...nextPaths].flatMap((path) => {
        const metadata = itemMetadata[path]
        return metadata ? [[path, metadata] as const] : []
      }))

      const ready: SourceSnapshotMetadata = {
        configHash,
        workspace: definition.name,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        mountIdentity,
        ownedAncestors: [...ownedAncestors],
        ownedDirectories: [...ownedDirectories],
        directoryIdentities,
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
          ownsMount,
          mountIdentity,
          ownedAncestors: [...ownedAncestors],
          ownedDirectories: [...ownedDirectories],
          directoryIdentities,
          bytes: Math.max(0, (existing.bytes || 0) + persistedBytesDelta),
          files: scopedItems ? Object.keys(scopedItems).length : 0,
          items: scopedItems,
        }))
      }
      else if (source.materialize === "startup") {
        // Keep ownership evidence for removal without treating a partial write
        // as a complete snapshot that subsequent startup reads can reuse.
        await control.mutate(() => writeSourceSnapshotMetadata(store, {
          ...ready,
          status: "updating",
          items: checkpointItems(itemMetadata),
          files: Object.keys(itemMetadata).length,
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
      const failed: SourceSnapshotMetadata = {
        pendingDirectories,
        configHash,
        workspace: definition.name,
        source: source.key,
        mountPath: source.mountPath,
        ownsMount,
        mountIdentity,
        ownedAncestors: [...ownedAncestors],
        ownedDirectories: [...ownedDirectories],
        directoryIdentities,
        status: "error",
        revision,
        error: error instanceof Error ? error.message : String(error),
        files: retainPriorItems && checkpointItemsMetadata ? Object.keys(checkpointItemsMetadata).length : sourceFiles,
        bytes: retainPriorItems ? Math.max(0, (existing?.bytes || 0) + persistedBytesDelta) : sourceBytes,
        items: checkpointItemsMetadata,
        cacheMaxAge: source.cache ? source.cache.maxAge : undefined,
      }
      const checkpoint = options.abortSignal?.aborted
        ? completeSource
          ? { ...failed, status: "updating" as const, error: undefined }
          : existing?.configHash === configHash
            ? { ...existing, pendingDirectories, ownsMount, mountIdentity, ownedAncestors: [...ownedAncestors], ownedDirectories: [...ownedDirectories], directoryIdentities, items: checkpointItemsMetadata }
            : source.materialize === "startup" ? { ...failed, status: "updating" as const, error: undefined } : undefined
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

  // Promotion reconciliation owns the workspace-root skill tree globally.
  // Scoped materializations must not clean up promotions belonging to sources
  // outside the requested scope; reconcile only complete root materializations.
  if (control.isCurrent() && rootMaterialization) {
    const previousPromotion = promotionReconciliationByStore.get(store)
    const promotion = (async () => {
      await previousPromotion
      await reconcilePromotedSourceSkills(store, configuredSources, control, definition.name)
    })()
    const tail = promotion.catch(() => {})
    promotionReconciliationByStore.set(store, tail)
    try { await promotion } finally {
      if (promotionReconciliationByStore.get(store) === tail) promotionReconciliationByStore.delete(store)
    }
  }

  return {
    bytes,
    directories,
    durationMs: Date.now() - started,
    files,
    path: normalizeWorkspacePath(options.path || ""),
    sources: resultSources.reverse(),
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
): Promise<{ contentEqual?: boolean, contentDigest?: string, digest?: string, size?: number }> {
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
      const written = control ? await control.mutate(write) : await write()
      if (!written.digest) {
        throw workspaceError("[vitehub] Workspace Store writeFileStream() must return a content digest.")
      }
      return { contentDigest: hash.digest("hex"), digest: written.digest, size }
    }
    const content = await contentStreamToBytes(file.contentStream)
    if (control) await control.mutate(() => store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata }))
    else await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
    return { contentEqual: previousContent !== undefined && contentEquals(previousContent, content), digest: await sha256(content), size: content.byteLength }
  }

  const content = file.content ?? ""
  if (control) await control.mutate(() => store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata }))
  else await store.writeFile(path, { path: file.path, content, mediaType: file.mediaType, metadata: file.metadata })
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
