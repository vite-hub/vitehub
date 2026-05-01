import { resolve } from "node:path"

import { files as filesLoader } from "./loaders/files.ts"
import { createLocalWorkspaceStore } from "./stores/local.ts"
import { createMemoryWorkspaceStore } from "./stores/memory.ts"

import type { LoaderContext, WorkspaceDefinition, WorkspaceStore } from "./types.ts"

export function createWorkspaceStore(definition: WorkspaceDefinition): WorkspaceStore {
  if (definition.store && "readFile" in definition.store) return definition.store
  if (definition.store?.provider === "memory") return createMemoryWorkspaceStore()

  const rootDir = definition.rootDir || process.cwd()
  const root = definition.store?.root || `.vitehub/workspaces/${definition.name}`
  return createLocalWorkspaceStore(resolve(rootDir, root))
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
