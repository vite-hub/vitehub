import { useWorkspaceAssets } from "./asset-registry.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, sourceMountIntersectsPath, type ResolvedWorkspaceSource } from "./sources/config.ts"
import { prepareWorkspaceSource } from "./sources/preparation.ts"
import { sourceSnapshotMetaKey } from "./sources/materialization.ts"
import { invalidateWorkspaceSourceMaterialization } from "./sources/view.ts"
import { createWorkspaceStoreFromProvider } from "./storage/provider.ts"
import { createCurrentSnapshotFromStore } from "./storage/utils.ts"

import type { LoaderContext, SourceContext, WorkspaceAssets, WorkspaceDefinition, WorkspaceLoaderSource, WorkspacePublishOptions, WorkspaceSnapshot, WorkspaceStore } from "./core/types.ts"

const buildSourcesMetaKey = "workspace:build-sources"

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

export async function publishWorkspaceSnapshot(definition: WorkspaceDefinition, store: WorkspaceStore, snapshot: WorkspaceSnapshot, durable = true, abortSignal?: AbortSignal): Promise<void> {
  for (const publisher of definition.publish || []) {
    abortSignal?.throwIfAborted()
    await publisher.publish({
      abortSignal,
      durable,
      workspace: definition,
      store,
      rootDir: definition.rootDir || process.cwd(),
      snapshot,
    })
  }
}

const STORE_MUTATIONS = new Set(["mkdir", "rebase", "rm", "setMeta", "writeFile", "writeFileConditional", "writeFileStream"])

function createAbortFencedStore(store: WorkspaceStore, abortSignal: AbortSignal) {
  const active = new Set<Promise<unknown>>()
  let settleIdle: (() => void) | undefined
  const idle = () => active.size
    ? new Promise<void>((resolve) => { settleIdle = resolve })
    : Promise.resolve()
  // SAFETY: The proxy preserves the WorkspaceStore contract and only wraps known mutation methods.
  const fenced = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (!STORE_MUTATIONS.has(String(property))) return value
      return (...args: unknown[]) => {
        abortSignal.throwIfAborted()
        const operation = Promise.resolve(Reflect.apply(value, target, args))
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
    },
  }) as WorkspaceStore
  return { fenced, idle }
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
  const { fenced, idle } = createAbortFencedStore(store, abortSignal)
  await waitForFencedSync(syncWorkspaceDefinitionInternal(definition, fenced, abortSignal), abortSignal, idle)
}

async function syncWorkspaceDefinitionInternal(definition: WorkspaceDefinition, store: WorkspaceStore, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted()
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const hasExplicitLoaders = !!definition.loaders?.length
  const ctxSource = createSourceContext(definition, undefined, store)
  const sources = normalizeWorkspaceSources(definition.sources)
  const buildSources = sources
    .filter(source => source.materialize === "build")
  const startupSources = sources.filter(source => source.materialize === "startup")
  const hasBuildSourceState = await reconcileBuildSourceMounts(definition, store, buildSources, startupSources, abortSignal)
  abortSignal?.throwIfAborted()
  const bundledBuildSources = !hasExplicitLoaders
    ? await syncRuntimeBuildAssets(definition, store, buildSources, abortSignal)
    : undefined
  abortSignal?.throwIfAborted()
  if (bundledBuildSources && buildSources.every(source => bundledBuildSources.has(source.key))) {
    const snapshot = await store.snapshot({ name: "sync" })
    await publishWorkspaceSnapshot(definition, store, snapshot, true, abortSignal)
    return
  }
  if (!hasBuildSourceState && !hasExplicitLoaders) return

  const normalizedSources = buildSources
    .filter(source => !bundledBuildSources?.has(source.key))
    .map(source => createMountedBuildSource(source))
  const ctx: LoaderContext = {
    abortSignal,
    workspace: definition.name,
    rootDir: ctxSource.rootDir,
    sourceRootDir: ctxSource.sourceRootDir,
    sources: normalizedSources,
    store,
    parseData: async input => input.data,
    generateDigest: input => JSON.stringify(input),
    logger: console,
  }

  for (const loader of loaders) {
    abortSignal?.throwIfAborted()
    await loader.load(ctx)
  }
  abortSignal?.throwIfAborted()
  const snapshot = await store.snapshot({ name: "sync" })
  await publishWorkspaceSnapshot(definition, store, snapshot, true, abortSignal)
}

async function reconcileBuildSourceMounts(definition: WorkspaceDefinition, store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[], startupSources: ResolvedWorkspaceSource[], abortSignal?: AbortSignal): Promise<boolean> {
  abortSignal?.throwIfAborted()
  const previousSources = await readSyncedBuildSources(store)
  abortSignal?.throwIfAborted()
  const hasBuildSourceState = previousSources.length > 0 || currentSources.length > 0
  const resetPaths = [...new Set([
    ...previousSources.map(source => source.mountPath),
    ...currentSources.map(source => source.mountPath),
  ])]

  for (const mountPath of resetPaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    abortSignal?.throwIfAborted()
    const affected = startupSources.filter(source => sourceMountIntersectsPath(source, mountPath))
    await invalidateWorkspaceSourceMaterialization(definition, store, affected.map(source => source.key))
    for (const source of affected) await store.setMeta?.(sourceSnapshotMetaKey(source.key), {})
    abortSignal?.throwIfAborted()
    await store.rm(mountPath, { recursive: true, force: true })
    abortSignal?.throwIfAborted()
  }
  for (const source of [...previousSources, ...currentSources].filter(source => !source.mountPath)) {
    abortSignal?.throwIfAborted()
    const removedPaths = await rootBuildSourceFilePaths(store, source)
    const affected = startupSources.filter(startup => removedPaths.some(path => sourceMountIntersectsPath(startup, path)))
    await invalidateWorkspaceSourceMaterialization(definition, store, affected.map(startup => startup.key))
    for (const startup of affected) await store.setMeta?.(sourceSnapshotMetaKey(startup.key), {})
    abortSignal?.throwIfAborted()
    await removeRootBuildSourceFiles(store, removedPaths)
    abortSignal?.throwIfAborted()
  }

  for (const mountPath of [...new Set(currentSources.map(source => source.mountPath))].filter(Boolean).sort((a, b) => a.length - b.length)) {
    abortSignal?.throwIfAborted()
    await store.mkdir(mountPath, { recursive: true })
    abortSignal?.throwIfAborted()
  }

  abortSignal?.throwIfAborted()
  await store.setMeta?.(buildSourcesMetaKey, currentSources.map(({ key, mountPath }) => ({ key, mountPath })))
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
      metadata: sourceKey ? { ...entry.metadata, source: sourceKey } : entry.metadata,
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

async function readSyncedBuildSources(store: WorkspaceStore): Promise<SyncedBuildSource[]> {
  const value = await store.getMeta?.(buildSourcesMetaKey)
  if (!Array.isArray(value)) return []
  return value.filter(isSyncedBuildSource)
}

async function rootBuildSourceFilePaths(store: WorkspaceStore, source: SyncedBuildSource) {
  const entries = await store.list("", { recursive: true })
  return entries
    .filter(entry => entry.type === "file" && entry.metadata?.source === source.key)
    .map(entry => entry.path)
}

async function removeRootBuildSourceFiles(store: WorkspaceStore, paths: string[]) {
  await Promise.all(paths.map(path => store.rm(path, { force: true })))
}

function isSyncedBuildSource(value: unknown): value is SyncedBuildSource {
  return !!value
    && typeof value === "object"
    && typeof (value as SyncedBuildSource).key === "string"
    && typeof (value as SyncedBuildSource).mountPath === "string"
}

function createMountedBuildSource(source: ResolvedWorkspaceSource): WorkspaceLoaderSource {
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
      return { ...item, path, metadata: { ...item.metadata, source: source.key } }
    },
  }
}
