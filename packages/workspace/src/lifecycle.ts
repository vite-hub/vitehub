import { readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"

import { listMatchingFiles } from "@vitehub/internal/definition-catalog"

import { files as filesLoader } from "./loaders/files.ts"
import { normalizeWorkspacePath } from "./path.ts"
import { createSourceContext, normalizeWorkspaceSources, type ResolvedWorkspaceSource } from "./source-config.ts"
import { createWorkspaceStoreFromProvider } from "./store-provider.ts"
import { hasWorkspaceDirectoryConfig, isWorkspaceAssetFile } from "./workspace-config.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceSource, WorkspaceSourceItem, WorkspaceStore } from "./types.ts"

function workspaceDirectory(rootDir: string, name: string) {
  return resolve(rootDir, "server", "workspaces", ...name.split("/"))
}

function createImplicitWorkspaceDirectorySource(definition: WorkspaceDefinition): WorkspaceSource | undefined {
  const rootDir = definition.rootDir || process.cwd()
  const directory = workspaceDirectory(rootDir, definition.name)
  if (!hasWorkspaceDirectoryConfig(directory)) return

  return {
    name: "directory-assets",
    async getKeys() {
      return listMatchingFiles(directory, isWorkspaceAssetFile).map(file => normalizeWorkspacePath(relative(directory, file))).sort()
    },
    async getItem(key: string): Promise<WorkspaceSourceItem> {
      const target = resolve(directory, key)
      const [bytes, info] = await Promise.all([readFile(target), stat(target)])
      return {
        key,
        path: key,
        content: new Uint8Array(bytes),
        metadata: { mtime: info.mtimeMs },
      }
    },
  }
}

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  return createWorkspaceStoreFromProvider(definition)
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const implicitDirectorySource = createImplicitWorkspaceDirectorySource(definition)
  const ctxSource = createSourceContext(definition)
  const normalizedSources = normalizeWorkspaceSources(definition.sources)
    .filter(source => source.materialize === "build")
    .map(source => createMountedBuildSource(source))
  const ctx: LoaderContext = {
    workspace: definition.name,
    rootDir: ctxSource.rootDir,
    sources: implicitDirectorySource ? [implicitDirectorySource, ...normalizedSources] : normalizedSources,
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

function createMountedBuildSource(source: ResolvedWorkspaceSource): WorkspaceSource {
  return {
    ...source.source,
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
