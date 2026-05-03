import { createWorkspaceSourceView } from "./source-view.ts"
import { createWorkspaceStoreFromProvider } from "./store-provider.ts"
import { getCachedWorkspaceStore } from "./workspace-cache.ts"
import type {
  Workspace,
  WorkspaceDefinition,
} from "./types.ts"

export function createWorkspace(definition: WorkspaceDefinition): Workspace {
  const store = getCachedWorkspaceStore(definition, () => createWorkspaceStoreFromProvider(definition))
  const files = createWorkspaceSourceView(definition, store)

  const workspace: Workspace = {
    name: definition.name,
    async sync() {
      const { syncWorkspaceDefinition } = await import("./lifecycle.ts")
      await syncWorkspaceDefinition(definition, store)
    },
    async readFile(path, options) {
      return await files.readFile(path, options)
    },
    async writeFile(path, content, options) {
      await files.writeFile(path, content, options)
    },
    async list(path, options) {
      return await files.list(path, options)
    },
    async glob(pattern, options) {
      return await files.glob(pattern, options)
    },
    async search(query) {
      return await files.search(query)
    },
    async stat(path) {
      return await files.stat(path)
    },
    async exists(path) {
      return await files.exists(path)
    },
    async mkdir(path, options) {
      await files.mkdir(path, options)
    },
    async rm(path, options) {
      await files.rm(path, options)
    },
    async snapshot(options) {
      return await store.snapshot(options)
    },
    async diff(options) {
      return await store.diff(options)
    },
  }

  return workspace
}
