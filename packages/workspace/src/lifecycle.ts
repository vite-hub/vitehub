import { resolve } from "node:path"

import { normalizeWorkspaceStoreOptions } from "./config.ts"
import { files as filesLoader } from "./loaders/files.ts"
import { getWorkspaceRuntimeConfig } from "./runtime/config.ts"
import { createCloudflareArtifactsWorkspaceStore } from "./stores/cloudflare-artifacts.ts"
import { createLocalWorkspaceStore } from "./stores/local.ts"
import { createMemoryWorkspaceStore } from "./stores/memory.ts"
import { createVercelBlobWorkspaceStore } from "./stores/vercel-blob.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceStore } from "./types.ts"

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  if (definition.store && "readFile" in definition.store) return definition.store

  const rootDir = definition.rootDir || process.cwd()
  const runtimeConfig = getWorkspaceRuntimeConfig()
  const runtimeStore = runtimeConfig ? runtimeConfig.store : undefined
  const store = normalizeWorkspaceStoreOptions(definition.store || runtimeStore, {
    env: typeof process !== "undefined" ? process.env : {},
    hosting: typeof process !== "undefined" ? process.env.VITEHUB_HOSTING || process.env.NITRO_PRESET : undefined,
    rootDir,
  })

  if (store?.provider === "memory") return createMemoryWorkspaceStore()
  if (store?.provider === "cloudflare-artifacts") return createCloudflareArtifactsWorkspaceStore(store, definition.name)
  if (store?.provider === "vercel-blob") return createVercelBlobWorkspaceStore(store, definition.name)

  const root = store?.root
    ? resolve(rootDir, store.root)
    : runtimeConfig
      ? resolve(runtimeConfig.root, definition.name)
      : resolve(rootDir, ".vitehub/workspaces", definition.name)
  return createLocalWorkspaceStore(root)
}

export async function syncWorkspaceDefinition(definition: WorkspaceDefinition, store: WorkspaceStore): Promise<void> {
  const loaders = definition.loaders?.length ? definition.loaders : [filesLoader()]
  const ctx: LoaderContext = {
    workspace: definition.name,
    rootDir: definition.rootDir || process.cwd(),
    sources: definition.sources || [],
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
