import { createHash } from "node:crypto"
import { useWorkspaceAssets } from "./asset-registry.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { files as filesLoader } from "./loaders/files.ts"
import { contentStreamChunks, normalizeWorkspacePath, sha256 } from "./core/path.ts"
import { workspaceError } from "./core/errors.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountIntersectsPath, type ResolvedWorkspaceSource } from "./sources/config.ts"
import { readWorkspaceFileOwner, recordWorkspaceFileOwner, removeWorkspaceOwnedFile } from "./sources/file-ownership.ts"
import { withWorkspaceFileCheckpoint } from "./sources/owned-write.ts"
import { prepareWorkspaceSource } from "./sources/preparation.ts"
import { invalidateSourceSnapshot, readCurrentSourceSnapshot, reconcileRemovedStartupSources, sourceSnapshotOwnsAnyPath } from "./sources/materialization.ts"
import { invalidateWorkspaceSourceMaterialization } from "./sources/view.ts"
import { workspaceStoreIdentity, registerWorkspaceStoreAlias } from "./storage/identity.ts"
import { withWorkspaceStoreMutation } from "./storage/mutation.ts"
import { createWorkspaceStoreFromProvider } from "./storage/provider.ts"
import { createCurrentSnapshotFromStore } from "./storage/utils.ts"

import type { LoaderContext, SourceContext, WorkspaceAssets, WorkspaceDefinition, WorkspaceFile, WorkspaceLoaderSource, WorkspacePublishOptions, WorkspaceSnapshot, WorkspaceStore, WorkspaceStreamFile } from "./core/types.ts"

const buildSourcesMetaKey = (workspace: string) => `workspace:${encodeURIComponent(workspace)}:build-sources`

const buildFilesMetaKey = (workspace: string) => `workspace:${encodeURIComponent(workspace)}:build-files`

// Metadata-limited Stores retain build state for the same lifetime as file ownership.
const volatileBuildMetadata = new WeakMap<object, Map<string, unknown>>()

async function readBuildMetadata(store: WorkspaceStore, key: string): Promise<unknown> {
  const state = volatileBuildMetadata.get(workspaceStoreIdentity(store))
  return state?.has(key) ? state.get(key) : await store.getMeta?.(key)
}

async function writeBuildMetadata(store: WorkspaceStore, key: string, value: unknown): Promise<void> {
  const identity = workspaceStoreIdentity(store)
  let state = volatileBuildMetadata.get(identity)
  if (!state) {
    state = new Map()
    volatileBuildMetadata.set(identity, state)
  }
  state.set(key, value)
  if (store.getMeta && store.setMeta) {
    await store.setMeta(key, value)
    state.delete(key)
  }
}

const buildDirectoriesMetaKey = (workspace: string) => `workspace:${encodeURIComponent(workspace)}:build-directories`

function parentPaths(path: string): string[] {
  const parts = normalizeWorkspacePath(path).split("/")
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"))
}

async function readBuildDirectories(store: WorkspaceStore, workspace: string): Promise<string[]> {
  const value = await readBuildMetadata(store, buildDirectoriesMetaKey(workspace))
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Directory ownership is an untyped persistence boundary.
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && !!path) : []
}

const buildDirectoryUsersMetaKey = "workspace:build-directory-users"

async function readBuildDirectoryUsers(store: WorkspaceStore): Promise<Record<string, string[]>> {
  const value = await readBuildMetadata(store, buildDirectoryUsersMetaKey)
  const users: Record<string, string[]> = Object.create(null)
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Shared directory claims are an untyped persistence boundary.
  if (!value || typeof value !== "object" || Array.isArray(value)) return users
  return Object.assign(users, Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] =>
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate persisted Workspace names before using shared claims.
    Array.isArray(entry[1]) && entry[1].every(name => typeof name === "string"))))
}

async function missingBuildDirectories(store: WorkspaceStore, paths: string[]): Promise<Set<string>> {
  const missing = new Set<string>()
  for (const path of paths) if (!await store.stat(path)) missing.add(path)
  return missing
}

async function recordBuildDirectories(store: WorkspaceStore, workspace: string, paths: string[], missing: Set<string>): Promise<void> {
  const owned = new Set(await readBuildDirectories(store, workspace))
  const users = await readBuildDirectoryUsers(store)
  for (const path of paths) {
    if (!missing.has(path) && !Object.hasOwn(users, path)) continue
    if ((await store.stat(path))?.type !== "directory") continue
    owned.add(path)
    users[path] = [...new Set([...(Object.hasOwn(users, path) ? users[path]! : []), workspace])]
  }
  // Persist cleanup authority before publishing a claim that other Workspaces retain.
  await writeBuildMetadata(store, buildDirectoriesMetaKey(workspace), [...owned])
  await writeBuildMetadata(store, buildDirectoryUsersMetaKey, users)
}

async function pruneBuildDirectories(store: WorkspaceStore, workspace: string): Promise<void> {
  await withWorkspaceStoreMutation(store, async () => {
    const owned = await readBuildDirectories(store, workspace)
    const users = await readBuildDirectoryUsers(store)
    const retained: string[] = []
    for (const path of owned.sort((a, b) => b.length - a.length)) {
      const others = (Object.hasOwn(users, path) ? users[path]! : []).filter(name => name !== workspace)
      if (others.length) {
        users[path] = others
        continue
      }
      if ((await store.stat(path))?.type !== "directory") {
        delete users[path]
        continue
      }
      if ((await store.list(path)).length) {
        retained.push(path)
        continue
      }
      if (!store.removeEmptyDirectory) {
        retained.push(path)
        continue
      }
      await store.removeEmptyDirectory(path)
      delete users[path]
    }
    await writeBuildMetadata(store, buildDirectoryUsersMetaKey, users)
    await writeBuildMetadata(store, buildDirectoriesMetaKey(workspace), retained)
  })
}

interface BuildFileRecord {
  source: string
  digest: string
}

async function createBuildLoaderStore(workspace: string, store: WorkspaceStore, sources: ResolvedWorkspaceSource[], mutationStore = store, abortSignal?: AbortSignal, trackOperation?: TrackLifecycleOperation): Promise<WorkspaceStore> {
  const records = await readBuildFiles(store, workspace)
  const record = async (path: string, source: unknown, digest: string) => {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Loader source values are an untyped extension boundary.
    if (typeof source !== "string") return
    const normalized = normalizeWorkspacePath(path)
    records[normalized] = { source, digest }
    try {
      await recordWorkspaceFileOwner(mutationStore, normalized, { workspace, source, digest })
    }
    finally {
      await writeBuildMetadata(mutationStore, buildFilesMetaKey(workspace), records)
    }
  }
  const checkpointWrite = async <T>(path: string, write: () => Promise<T>, checkpoint: (result: T) => Promise<void>) => {
    const normalized = normalizeWorkspacePath(path)
    const previous = records[normalized]
    return await withWorkspaceFileCheckpoint(mutationStore, path, write, checkpoint, async () => {
      if (previous) records[normalized] = previous
      else delete records[normalized]
      await writeBuildMetadata(mutationStore, buildFilesMetaKey(workspace), records)
    })
  }
  // Once accepted, a write and its ownership checkpoint settle together before abort returns.
  let writes = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    abortSignal?.throwIfAborted()
    const pending = writes.then(() => withWorkspaceStoreMutation(mutationStore, operation))
    writes = pending.then(() => {}, () => {})
    return trackOperation ? trackOperation(pending) : pending
  }
  const mounts = [...sources].sort((a, b) => b.mountPath.length - a.mountPath.length)
  const tag = <T extends WorkspaceFile | WorkspaceStreamFile>(path: string, file: T): T => {
    const normalized = normalizeWorkspacePath(path)
    const candidates = mounts.filter(source => !source.mountPath || normalized.startsWith(`${source.mountPath}/`))
    const declared = candidates.find(source => source.key === file.metadata?.source)
    const closest = candidates.filter(source => source.mountPath.length === candidates[0]?.mountPath.length)
    if (!declared && closest.length > 1) {
      throw workspaceError(`[vitehub] Loader output "${normalized}" matches multiple build Sources. Set metadata.source to the Source key that owns this output.`)
    }
    const source = declared ?? closest[0]
    return source ? { ...file, metadata: { ...file.metadata, workspaceBuildSource: source.key, workspaceSourceOwner: workspace } } : file
  }
  return new Proxy(store, {
    get(target, property) {
      if (property === "writeFile") return async (path: string, file: WorkspaceFile) => await mutate(async () => {
        const tagged = tag(path, file)
        const directories = parentPaths(path)
        const missing = await missingBuildDirectories(mutationStore, directories)
        await checkpointWrite(path, () => mutationStore.writeFile(path, tagged), async () => {
          try {
            await record(path, tagged.metadata?.workspaceBuildSource, await sha256(file.content))
          }
          finally {
            await recordBuildDirectories(mutationStore, workspace, directories, missing)
          }
        })
      })
      if (property === "writeFileConditional" && target.writeFileConditional) return async (path: string, file: WorkspaceFile, digest: string | null) => await mutate(async () => {
        const tagged = tag(path, file)
        const directories = parentPaths(path)
        const missing = await missingBuildDirectories(mutationStore, directories)
        await checkpointWrite(path, () => mutationStore.writeFileConditional!(path, tagged, digest), async () => {
          try {
            await record(path, tagged.metadata?.workspaceBuildSource, await sha256(file.content))
          }
          finally {
            await recordBuildDirectories(mutationStore, workspace, directories, missing)
          }
        })
      })
      if (property === "writeFileStream" && target.writeFileStream) return async (path: string, file: WorkspaceStreamFile) => await mutate(async () => {
        const tagged = tag(path, file)
        const hash = createHash("sha256")
        const content = (async function* () {
          for await (const chunk of contentStreamChunks(tagged.content)) {
            hash.update(chunk)
            yield chunk
          }
        })()
        const directories = parentPaths(path)
        const missing = await missingBuildDirectories(mutationStore, directories)
        return await checkpointWrite(path, () => mutationStore.writeFileStream!(path, { ...tagged, content }), async () => {
          try {
            await record(path, tagged.metadata?.workspaceBuildSource, hash.digest("hex"))
          }
          finally {
            await recordBuildDirectories(mutationStore, workspace, directories, missing)
          }
        })
      })
      return Reflect.get(target, property, target)?.bind(target)
    },
  })
}

interface SyncedBuildSource {
  key: string
  mountPath: string
}

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  return createWorkspaceStoreFromProvider(definition)
}

export async function publishWorkspace(definition: WorkspaceDefinition, store: WorkspaceStore, options: WorkspacePublishOptions = {}): Promise<void> {
  if (!definition.publish?.length) return

  const snapshot = await createCurrentSnapshotFromStore(store, options.name)
  await publishWorkspaceSnapshot(definition, store, snapshot, false)
}

type TrackLifecycleOperation = <T>(operation: Promise<T>) => Promise<T>

export async function publishWorkspaceSnapshot(definition: WorkspaceDefinition, store: WorkspaceStore, snapshot: WorkspaceSnapshot, durable = true, abortSignal?: AbortSignal, trackOperation?: TrackLifecycleOperation): Promise<void> {
  for (const publisher of definition.publish || []) {
    abortSignal?.throwIfAborted()
    const operation = publisher.publish({
      abortSignal,
      durable,
      workspace: definition,
      store,
      rootDir: definition.rootDir || process.cwd(),
      snapshot,
    })
    await (trackOperation ? trackOperation(operation) : operation)
  }
}

const STORE_MUTATIONS = new Set(["mkdir", "rebase", "removeEmptyDirectory", "rm", "setMeta", "snapshot", "writeFile", "writeFileConditional", "writeFileStream"])

function createAbortFencedStore(store: WorkspaceStore, abortSignal: AbortSignal) {
  const active = new Set<Promise<unknown>>()
  let settleIdle: (() => void) | undefined
  const idle = () => active.size
    ? new Promise<void>((resolve) => { settleIdle = resolve })
    : Promise.resolve()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation)
    void operation.then(() => {
      active.delete(operation)
      if (!active.size) {
        settleIdle?.()
        settleIdle = undefined
      }
    }, () => {
      active.delete(operation)
      if (!active.size) {
        settleIdle?.()
        settleIdle = undefined
      }
    })
    return operation
  }
  // SAFETY: The proxy preserves the WorkspaceStore contract and only wraps known mutation methods.
  const fenced = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (!STORE_MUTATIONS.has(String(property))) return value?.bind(target)
      if (value === undefined) return undefined
      return (...args: unknown[]) => {
        abortSignal.throwIfAborted()
        const operation = Promise.resolve(Reflect.apply(value, target, args))
        return track(operation)
      }
    },
  }) as WorkspaceStore
  registerWorkspaceStoreAlias(fenced, store)
  return { fenced, idle, track }
}

async function waitForFencedSync(operation: Promise<void>, signal: AbortSignal, idle: () => Promise<void>) {
  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => { void idle().then(() => reject(signal.reason)) }
    signal.addEventListener("abort", onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener("abort", onAbort)
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([operation, aborted])
  }
  finally {
    removeAbortListener()
  }
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return await syncWorkspaceDefinitionInternal(definition, store)
  const { fenced, idle, track } = createAbortFencedStore(store, abortSignal)
  await waitForFencedSync(syncWorkspaceDefinitionInternal(definition, fenced, abortSignal, store, track), abortSignal, idle)
}

async function syncWorkspaceDefinitionInternal(definition: WorkspaceDefinition, store: WorkspaceStore, abortSignal?: AbortSignal, materializationStore = store, trackOperation?: TrackLifecycleOperation): Promise<void> {
  abortSignal?.throwIfAborted()
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const hasExplicitLoaders = !!definition.loaders?.length
  const ctxSource = createSourceContext(definition, undefined, store)
  const sources = normalizeWorkspaceSources(definition.sources)
  const buildSources = sources
    .filter(source => source.materialize === "build")
  const startupSources = sources.filter(source => source.materialize === "startup")
  await reconcileRemovedStartupSources(definition.name, store, startupSources, undefined, materializationStore)
  abortSignal?.throwIfAborted()
  const hasBuildSourceState = await reconcileBuildSourceMounts(definition, store, materializationStore, buildSources, startupSources, abortSignal, trackOperation)
  abortSignal?.throwIfAborted()
  const buildStore = await createBuildLoaderStore(definition.name, store, buildSources, materializationStore, abortSignal, trackOperation)
  const bundledBuildSources = !hasExplicitLoaders
    ? await syncRuntimeBuildAssets(definition, buildStore, buildSources, abortSignal)
    : undefined
  abortSignal?.throwIfAborted()
  if (bundledBuildSources && buildSources.every(source => bundledBuildSources.has(source.key))) {
    await invalidateOverwrittenStartupSnapshots(definition, store, materializationStore, startupSources, buildSources)
    const snapshot = await store.snapshot({ name: "sync" })
    await publishWorkspaceSnapshot(definition, store, snapshot, true, abortSignal, trackOperation)
    return
  }
  if (!hasBuildSourceState && !hasExplicitLoaders) return

  const normalizedSources = buildSources
    .filter(source => !bundledBuildSources?.has(source.key))
    .map(source => createMountedBuildSource(source, definition.name))
  const ctx: LoaderContext = {
    abortSignal,
    workspace: definition.name,
    rootDir: ctxSource.rootDir,
    sourceRootDir: ctxSource.sourceRootDir,
    sources: normalizedSources,
    store: buildStore,
    parseData: async input => input.data,
    generateDigest: input => JSON.stringify(input),
    logger: console,
  }

  for (const loader of loaders) {
    abortSignal?.throwIfAborted()
    await loader.load(ctx)
  }
  abortSignal?.throwIfAborted()
  await invalidateOverwrittenStartupSnapshots(definition, store, materializationStore, startupSources, buildSources)
  const snapshot = await store.snapshot({ name: "sync" })
  await publishWorkspaceSnapshot(definition, store, snapshot, true, abortSignal, trackOperation)
}

async function invalidateOverwrittenStartupSnapshots(definition: WorkspaceDefinition, store: WorkspaceStore, materializationStore: WorkspaceStore, startupSources: ResolvedWorkspaceSource[], buildSources: ResolvedWorkspaceSource[]) {
  for (const source of startupSources) {
    const snapshot = await readCurrentSourceSnapshot(store, definition.name, source)
    if (snapshot?.status !== "ready") continue
    for (const path of Object.keys(snapshot.items || {})) {
      const file = await store.readFile(path)
      if (!file) continue
      const owner = await readWorkspaceFileOwner(store, path)
      const ownedByBuild = owner
        ? owner.workspace === definition.name && buildSources.some(buildSource => buildSource.key === owner.source)
          && await sha256(file.content) === owner.digest
        : (file.metadata?.workspaceSourceOwner === undefined || file.metadata.workspaceSourceOwner === definition.name)
          && buildSources.some(buildSource => buildSource.key === file.metadata?.source || buildSource.key === file.metadata?.workspaceBuildSource)
      if (!ownedByBuild) continue
      await invalidateWorkspaceSourceMaterialization(definition, materializationStore, [source.key])
      // Retain the item index so the next startup can still clean up its stale files.
      await invalidateSourceSnapshot(store, definition.name, source.key)
      break
    }
  }
}

async function reconcileBuildSourceMounts(definition: WorkspaceDefinition, store: WorkspaceStore, materializationStore: WorkspaceStore, currentSources: ResolvedWorkspaceSource[], startupSources: ResolvedWorkspaceSource[], abortSignal?: AbortSignal, trackOperation?: TrackLifecycleOperation): Promise<boolean> {
  abortSignal?.throwIfAborted()
  const previousSources = await readSyncedBuildSources(store, definition.name)
  abortSignal?.throwIfAborted()
  const hasBuildSourceState = previousSources.length > 0 || currentSources.length > 0
  const resetPaths = [...new Set([
    ...previousSources.map(source => source.mountPath),
    ...currentSources.map(source => source.mountPath),
  ])]

  const mutate = async (operation: () => Promise<void>) => {
    abortSignal?.throwIfAborted()
    const pending = operation()
    await (trackOperation ? trackOperation(pending) : pending)
  }

  for (const mountPath of resetPaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    abortSignal?.throwIfAborted()
    const buildKeys = [...previousSources, ...currentSources].filter(source => source.mountPath === mountPath).map(source => source.key)
    await mutate(() => withWorkspaceStoreMutation(materializationStore, async () => {
      const removedPaths = await buildSourceFilePaths(materializationStore, definition.name, mountPath, buildKeys)
      const affected: ResolvedWorkspaceSource[] = []
      for (const startup of startupSources.filter(source => sourceMountIntersectsPath(source, mountPath))) {
        const removesStartupMount = startup.mountPath === mountPath || startup.mountPath.startsWith(`${mountPath}/`)
        if (!removesStartupMount && await sourceSnapshotOwnsAnyPath(store, definition.name, startup.key, removedPaths) === false) continue
        affected.push(startup)
      }
      await invalidateWorkspaceSourceMaterialization(definition, materializationStore, affected.map(source => source.key))
      for (const source of affected) {
        await invalidateSourceSnapshot(store, definition.name, source.key)
      }
      abortSignal?.throwIfAborted()
      await removeBuildSourceFiles(materializationStore, definition.name, removedPaths)
    }))
    abortSignal?.throwIfAborted()
  }
  const rootSourceKeys = new Set([...previousSources, ...currentSources].filter(source => !source.mountPath).map(source => source.key))
  for (const key of rootSourceKeys) {
    abortSignal?.throwIfAborted()
    await mutate(() => withWorkspaceStoreMutation(materializationStore, async () => {
      const removedPaths = await buildSourceFilePaths(materializationStore, definition.name, "", [key])
      const affected: ResolvedWorkspaceSource[] = []
      for (const startup of startupSources) {
        if (!removedPaths.some(path => sourceMountIntersectsPath(startup, path))) continue
        if (await sourceSnapshotOwnsAnyPath(store, definition.name, startup.key, removedPaths) === false) continue
        affected.push(startup)
      }
      await invalidateWorkspaceSourceMaterialization(definition, materializationStore, affected.map(startup => startup.key))
      for (const startup of affected) {
        await invalidateSourceSnapshot(store, definition.name, startup.key)
      }
      abortSignal?.throwIfAborted()
      await removeBuildSourceFiles(materializationStore, definition.name, removedPaths)
    }))
    abortSignal?.throwIfAborted()
  }

  await mutate(() => pruneBuildDirectories(materializationStore, definition.name))

  for (const mountPath of [...new Set(currentSources.map(source => source.mountPath))].filter(Boolean).sort((a, b) => a.length - b.length)) {
    abortSignal?.throwIfAborted()
    await mutate(() => withWorkspaceStoreMutation(materializationStore, async () => {
      const directories = [...parentPaths(mountPath), mountPath]
      const missing = await missingBuildDirectories(materializationStore, directories)
      await materializationStore.mkdir(mountPath, { recursive: true })
      await recordBuildDirectories(materializationStore, definition.name, directories, missing)
    }))
    abortSignal?.throwIfAborted()
  }

  abortSignal?.throwIfAborted()
  await writeBuildMetadata(store, buildFilesMetaKey(definition.name), {})
  await writeBuildMetadata(store, buildSourcesMetaKey(definition.name), currentSources.map(({ key, mountPath }) => ({ key, mountPath })))
  return hasBuildSourceState
}

async function syncRuntimeBuildAssets(definition: WorkspaceDefinition, store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[], abortSignal?: AbortSignal): Promise<Set<string> | undefined> {
  abortSignal?.throwIfAborted()
  if (!currentSources.length) return undefined

  let assets: WorkspaceAssets
  try {
    assets = useWorkspaceAssets(definition.name)
  }
  catch (error) {
    if (getViteHubErrorShape(error)?.code === "WORKSPACE_NOT_FOUND") return undefined
    throw error
  }

  const entries = await assets.list("", { recursive: true })
  abortSignal?.throwIfAborted()
  const files = entries.filter(entry => entry.type === "file")
  const bundledPaths = new Set(files.map(entry => entry.path))
  const bundledSourceByPath = new Map<string, string>()
  const bundledBuildSources = new Set<string>()
  for (const source of currentSources) {
    abortSignal?.throwIfAborted()
    if (await hasCompleteBundledBuildSource(definition, store, source, bundledPaths, files, bundledSourceByPath, abortSignal)) {
      abortSignal?.throwIfAborted()
      bundledBuildSources.add(source.key)
    }
  }
  for (const entry of files) {
    abortSignal?.throwIfAborted()
    const sourceKey = typeof entry.metadata?.source === "string"
      ? entry.metadata.source
      : bundledSourceByPath.get(entry.path) || findBuildSourceForPath(entry.path, currentSources)?.key
    const content = await assets.readFile(entry.path, { encoding: "binary" })
    abortSignal?.throwIfAborted()
    await store.writeFile(entry.path, {
      path: entry.path,
      content,
      mediaType: entry.mediaType,
      metadata: sourceKey ? { ...entry.metadata, source: sourceKey, workspaceSourceOwner: definition.name } : entry.metadata,
    })
  }
  return bundledBuildSources
}

async function hasCompleteBundledBuildSource(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  source: ResolvedWorkspaceSource,
  bundledPaths: Set<string>,
  bundledFiles?: Array<{ path: string, metadata?: Record<string, unknown> }>,
  bundledSourceByPath?: Map<string, string>,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const probeKeys = source.source.probeKeys
  if (!probeKeys?.length) {
    const paths = bundledFiles
      ?.filter(file => file.metadata?.source === source.key)
      .map(file => file.path) ?? []
    const sourcePaths = await tryListBuildSourcePaths(definition, store, source, abortSignal)
    if (sourcePaths && !sourcePaths.every(path => paths.includes(path))) return false
    for (const path of paths) bundledSourceByPath?.set(path, source.key)
    return paths.length > 0
  }
  const paths = probeKeys.map(key => normalizeWorkspacePath(`${source.mountPath}/${key}`))
  if (!paths.every(path => bundledPaths.has(path))) return false
  for (const path of paths) bundledSourceByPath?.set(path, source.key)
  return true
}

async function tryListBuildSourcePaths(
  definition: WorkspaceDefinition,
  store: WorkspaceStore,
  source: ResolvedWorkspaceSource,
  abortSignal?: AbortSignal,
): Promise<string[] | undefined> {
  const ctx = createSourceContext(definition, { key: source.key, mountPath: source.mountPath }, store, { abortSignal })
  try {
    await prepareWorkspaceSource(source.source, ctx)
    return (await source.source.getKeys(ctx))
      .map(key => normalizeWorkspacePath(`${source.mountPath}/${key}`))
  }
  catch {
    return undefined
  }
}

function findBuildSourceForPath(path: string, sources: ResolvedWorkspaceSource[]): ResolvedWorkspaceSource | undefined {
  const matches = sources
    .filter(source => !source.mountPath || path === source.mountPath || path.startsWith(`${source.mountPath}/`))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0]
  if (!matches?.mountPath && sources.filter(source => !source.mountPath).length > 1) return undefined
  return matches
}

async function readSyncedBuildSources(store: WorkspaceStore, workspace: string): Promise<SyncedBuildSource[]> {
  const value = await readBuildMetadata(store, buildSourcesMetaKey(workspace))
  if (!Array.isArray(value)) return []
  return value.filter(isSyncedBuildSource)
}

async function readBuildFiles(store: WorkspaceStore, workspace: string): Promise<Record<string, BuildFileRecord>> {
  const value = await readBuildMetadata(store, buildFilesMetaKey(workspace))
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Metadata is an untyped persistence boundary.
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, BuildFileRecord] => {
    const record: unknown = entry[1]
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Persisted entries must validate both ownership fields before authorizing cleanup.
    return !!record && typeof record === "object" && "source" in record && typeof record.source === "string"
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Persisted digests must be strings before authorizing cleanup.
      && "digest" in record && typeof record.digest === "string"
  }))
}

async function buildSourceFilePaths(store: WorkspaceStore, workspace: string, mountPath: string, keys: string[]) {
  const paths: string[] = []
  const records = await readBuildFiles(store, workspace)
  for (const [path, record] of Object.entries(records)) {
    if (keys.includes(record.source)) await readWorkspaceFileOwner(store, path, true)
  }
  for (const entry of await store.list(mountPath, { recursive: true })) {
    if (entry.type !== "file") continue
    const file = entry.metadata ? undefined : await store.readFile(entry.path)
    const metadata = entry.metadata ?? file?.metadata
    if (metadata?.workspaceSourceOwner !== undefined && metadata.workspaceSourceOwner !== workspace) continue
    const owner = await readWorkspaceFileOwner(store, entry.path)
    const record = records[entry.path] ?? (owner?.workspace === workspace && owner.digest
      ? { source: owner.source, digest: owner.digest }
      : undefined)
    if (record && keys.includes(record.source)) {
      // Partial legacy ownership tags cannot authorize a metadata fallback.
      if (metadata?.workspaceSourceOwner === undefined && (metadata?.source !== undefined || metadata?.workspaceBuildSource !== undefined)) continue
      if (owner?.workspace !== workspace || owner.source !== record.source || owner.digest !== record.digest) continue
      if (entry.digest !== record.digest) {
        const current = file ?? await store.readFile(entry.path)
        if (!current || await sha256(current.content) !== record.digest) continue
      }
      paths.push(entry.path)
    }
    else if (metadata?.workspaceSourceOwner === workspace && keys.some(key => metadata.source === key || metadata.workspaceBuildSource === key)) {
      paths.push(entry.path)
    }
  }
  return paths
}

async function removeBuildSourceFiles(store: WorkspaceStore, workspace: string, paths: string[]) {
  const records = await readBuildFiles(store, workspace)
  for (const path of paths) {
    await removeWorkspaceOwnedFile(store, path)
    delete records[path]
    await writeBuildMetadata(store, buildFilesMetaKey(workspace), records)
  }
}

function isSyncedBuildSource(value: unknown): value is SyncedBuildSource {
  return !!value
    && typeof value === "object"
    && typeof (value as SyncedBuildSource).key === "string"
    && typeof (value as SyncedBuildSource).mountPath === "string"
}

function createMountedBuildSource(source: ResolvedWorkspaceSource, workspace: string): WorkspaceLoaderSource {
  const sourceContexts = new WeakMap<SourceContext, SourceContext>()

  function getSourceContext(ctx: Parameters<WorkspaceLoaderSource["getKeys"]>[0]) {
    let sourceContext = sourceContexts.get(ctx)
    if (sourceContext) return sourceContext
    sourceContext = {
      ...ctx,
      mountPath: source.mountPath,
      source: source.key,
    }
    sourceContexts.set(ctx, sourceContext)
    return sourceContext
  }

  return {
    ...source.source,
    key: source.key,
    async resolveRevision(ctx) {
      const sourceContext = getSourceContext(ctx)
      const revision = await source.source.resolveRevision?.(sourceContext)
      if (revision) sourceContext.revision = revision
      return revision
    },
    async prepare(ctx) {
      await prepareWorkspaceSource(source.source, getSourceContext(ctx))
    },
    async getKeys(ctx) {
      return await source.source.getKeys(getSourceContext(ctx))
    },
    async getItem(key, ctx) {
      const item = await source.source.getItem(key, getSourceContext(ctx))
      const path = normalizeWorkspacePath(`${source.mountPath}/${item.path || item.key}`)
      return { ...item, path, metadata: { ...item.metadata, source: source.key, workspaceSourceOwner: workspace } }
    },
  }
}
