import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./core/path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./sources/config.ts"
import { createWorkspaceStoreFromProvider } from "./storage/provider.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceLoaderSource, WorkspaceStore } from "./core/types.ts"

const buildSourcesMetaKey = "workspace:build-sources"

interface SyncedBuildSource {
  key: string
  mountPath: string
}

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  return createWorkspaceStoreFromProvider(definition)
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const ctxSource = createSourceContext(definition)
  const buildSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "build")
  await reconcileBuildSourceMounts(store, buildSources)
  const normalizedSources = buildSources.map(source => createMountedBuildSource(source))
  const ctx: LoaderContext = {
    workspace: definition.name,
    rootDir: ctxSource.rootDir,
    sources: normalizedSources,
    store,
    parseData: async input => input.data,
    generateDigest: input => JSON.stringify(input),
    logger: console,
  }

  for (const loader of loaders) {
    await loader.load(ctx)
  }
  await store.snapshot({ name: "sync" })
  for (const publisher of definition.publish || []) {
    await publisher.publish({
      workspace: definition,
      store,
      rootDir: definition.rootDir || process.cwd(),
    })
  }
}

async function reconcileBuildSourceMounts(store: WorkspaceStore, currentSources: ResolvedWorkspaceSource[]) {
  const previousSources = await readSyncedBuildSources(store)
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
  return {
    ...source.source,
    key: source.key,
    async getKeys(ctx) {
      return await source.source.getKeys(ctx)
    },
    async getItem(key, ctx) {
      const item = await source.source.getItem(key, ctx)
      const path = normalizeWorkspacePath(`${source.mountPath}/${item.path || item.key}`)
      return { ...item, path, metadata: { ...item.metadata, source: source.key } }
    },
  }
}
