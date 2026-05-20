import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./source-config.ts"
import { createWorkspaceStoreFromProvider } from "./store-provider.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceLoaderSource, WorkspaceStore } from "./types.ts"

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  return createWorkspaceStoreFromProvider(definition)
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const ctxSource = createSourceContext(definition)
  const normalizedSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "build")
    .map(source => createMountedBuildSource(source))
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
      return { ...item, path }
    },
  }
}
