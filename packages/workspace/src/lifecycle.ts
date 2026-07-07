import { useWorkspaceAssets } from "./asset-registry.ts"
import { WorkspaceNotFoundError } from "./core/errors.ts"
import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./sources/config.ts"
import { createWorkspaceStoreFromProvider } from "./storage/provider.ts"

import type { LoaderContext, WorkspaceAssets, WorkspaceDefinition, WorkspaceLoaderSource, WorkspaceSnapshot, WorkspaceStore } from "./core/types.ts"

const buildSourcesMetaKey = "workspace:build-sources"

interface SyncedBuildSource {
  key: string
  mountPath: string
}

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  return createWorkspaceStoreFromProvider(definition)
}

export async function publishWorkspaceSnapshot(definition: WorkspaceDefinition, store: WorkspaceStore, snapshot: WorkspaceSnapshot): Promise<void> {
  for (const publisher of definition.publish || []) {
    await publisher.publish({
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
  if (!hasExplicitLoaders && await syncRuntimeBuildAssets(definition, store, buildSources)) {
    const snapshot = await store.snapshot({ name: "sync" })
    await publishWorkspaceSnapshot(definition, store, snapshot)
    return
  }
  if (!hasBuildSourceState && !hasExplicitLoaders) return

  const normalizedSources = buildSources.map(source => createMountedBuildSource(source))
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

async function syncRuntimeBuildAssets(definition: WorkspaceDefinition, store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[]): Promise<boolean> {
  if (!currentSources.length) return false

  let assets: WorkspaceAssets
  try {
    assets = useWorkspaceAssets(definition.name)
  }
  catch (error) {
    if (error instanceof WorkspaceNotFoundError) return false
    throw error
  }

  const entries = await assets.list("", { recursive: true })
  const files = entries.filter(entry => entry.type === "file")
  let hasBundledSourceAsset = false
  for (const entry of files) {
    const source = findBuildSourceForPath(entry.path, currentSources)
    if (source) hasBundledSourceAsset = true
    await store.writeFile(entry.path, {
      path: entry.path,
      content: await assets.readFile(entry.path, { encoding: "binary" }),
      mediaType: entry.mediaType,
      metadata: source ? { source: source.key } : undefined,
    })
  }
  return hasBundledSourceAsset
}

function findBuildSourceForPath(path: string, sources: ResolvedWorkspaceSource[]): ResolvedWorkspaceSource | undefined {
  return sources
    .filter(source => !source.mountPath || path === source.mountPath || path.startsWith(`${source.mountPath}/`))
    .sort((left, right) => right.mountPath.length - left.mountPath.length)[0]
}

async function readSyncedBuildSources(store: WorkspaceStore): Promise<SyncedBuildSource[]> {
  const value = await store.getMeta?.(buildSourcesMetaKey)
  if (!Array.isArray(value)) return []
  return value.filter(isSyncedBuildSource)
}

async function removeRootBuildSourceFiles(store: WorkspaceStore, source: SyncedBuildSource) {
  const entries = await store.list("", { recursive: true })
  await Promise.all(entries.map(async (entry) => {
    if (entry.type !== "file") return
    const file = await store.readFile(entry.path)
    if (file?.metadata?.source === source.key) await store.rm(entry.path, { force: true })
  }))
}

function isSyncedBuildSource(value: unknown): value is SyncedBuildSource {
  return !!value
    && typeof value === "object"
    && typeof (value as SyncedBuildSource).key === "string"
    && typeof (value as SyncedBuildSource).mountPath === "string"
}

function createMountedBuildSource(source: ResolvedWorkspaceSource): WorkspaceLoaderSource {
  function getSourceContext(ctx: Parameters<WorkspaceLoaderSource["getKeys"]>[0]) {
    return {
      ...ctx,
      mountPath: source.mountPath,
      source: source.key,
    }
  }

  return {
    ...source.source,
    key: source.key,
    async prepare(ctx) {
      await source.source.prepare?.(getSourceContext(ctx))
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
