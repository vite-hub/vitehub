import { useWorkspaceAssets } from "./asset-registry.ts"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./sources/config.ts"
import { prepareWorkspaceSource } from "./sources/preparation.ts"
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

export async function publishWorkspaceSnapshot(definition: WorkspaceDefinition, store: WorkspaceStore, snapshot: WorkspaceSnapshot, durable = true): Promise<void> {
  for (const publisher of definition.publish || []) {
    await publisher.publish({
      durable,
      workspace: definition,
      store,
      rootDir: definition.rootDir || process.cwd(),
      snapshot,
    })
  }
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const hasExplicitLoaders = !!definition.loaders?.length
  const ctxSource = createSourceContext(definition, undefined, store)
  const buildSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "build")
  const hasBuildSourceState = await reconcileBuildSourceMounts(store, buildSources)
  const bundledBuildSources = !hasExplicitLoaders
    ? await syncRuntimeBuildAssets(definition, store, buildSources)
    : undefined
  if (bundledBuildSources && buildSources.every(source => bundledBuildSources.has(source.key))) {
    const snapshot = await store.snapshot({ name: "sync" })
    await publishWorkspaceSnapshot(definition, store, snapshot)
    return
  }
  if (!hasBuildSourceState && !hasExplicitLoaders) return

  const normalizedSources = buildSources
    .filter(source => !bundledBuildSources?.has(source.key))
    .map(source => createMountedBuildSource(source))
  const ctx: LoaderContext = {
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
    await loader.load(ctx)
  }
  const snapshot = await store.snapshot({ name: "sync" })
  await publishWorkspaceSnapshot(definition, store, snapshot)
}

async function reconcileBuildSourceMounts(store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[]): Promise<boolean> {
  const previousSources = await readSyncedBuildSources(store)
  const hasBuildSourceState = previousSources.length > 0 || currentSources.length > 0
  const resetPaths = [...new Set([
    ...previousSources.map(source => source.mountPath),
    ...currentSources.map(source => source.mountPath),
  ])]

  for (const mountPath of resetPaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    await store.rm(mountPath, { recursive: true, force: true })
  }
  for (const source of [...previousSources, ...currentSources].filter(source => !source.mountPath)) {
    await removeRootBuildSourceFiles(store, source)
  }

  for (const mountPath of [...new Set(currentSources.map(source => source.mountPath))].filter(Boolean).sort((a, b) => a.length - b.length)) {
    await store.mkdir(mountPath, { recursive: true })
  }

  await store.setMeta?.(buildSourcesMetaKey, currentSources.map(({ key, mountPath }) => ({ key, mountPath })))
  return hasBuildSourceState
}

async function syncRuntimeBuildAssets(definition: WorkspaceDefinition, store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[]): Promise<Set<string> | undefined> {
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
  const files = entries.filter(entry => entry.type === "file")
  const bundledPaths = new Set(files.map(entry => entry.path))
  const bundledSourceByPath = new Map<string, string>()
  const bundledBuildSources = new Set<string>()
  for (const source of currentSources) {
    if (await hasCompleteBundledBuildSource(definition, store, source, bundledPaths, files, bundledSourceByPath)) {
      bundledBuildSources.add(source.key)
    }
  }
  for (const entry of files) {
    const sourceKey = typeof entry.metadata?.source === "string"
      ? entry.metadata.source
      : bundledSourceByPath.get(entry.path) || findBuildSourceForPath(entry.path, currentSources)?.key
    await store.writeFile(entry.path, {
      path: entry.path,
      content: await assets.readFile(entry.path, { encoding: "binary" }),
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
): Promise<boolean> {
  const probeKeys = source.source.probeKeys
  if (!probeKeys?.length) {
    const paths = bundledFiles
      ?.filter(file => file.metadata?.source === source.key)
      .map(file => file.path) ?? []
    const sourcePaths = await tryListBuildSourcePaths(definition, store, source)
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
): Promise<string[] | undefined> {
  const ctx = createSourceContext(definition, { key: source.key, mountPath: source.mountPath }, store)
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

async function removeRootBuildSourceFiles(store: WorkspaceStore, source: SyncedBuildSource) {
  const entries = await store.list("", { recursive: true })
  await Promise.all(entries
    .filter(entry => entry.type === "file" && entry.metadata?.source === source.key)
    .map(entry => store.rm(entry.path, { force: true })))
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
      return await source.source.resolveRevision?.(getSourceContext(ctx))
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
