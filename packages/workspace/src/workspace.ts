import { createWorkspaceSourceView } from "./source-view.ts"
import { createWorkspaceStoreFromProvider } from "./store-provider.ts"
import { getCachedWorkspaceStore } from "./workspace-cache.ts"
import type {
  Workspace,
  WorkspaceDefinition,
  WorkspaceMount,
  WorkspaceMountOptions,
  WorkspaceSession,
} from "./types.ts"

function getStore(definition: WorkspaceDefinition) {
  return getCachedWorkspaceStore(definition, () => createWorkspaceStoreFromProvider(definition))
}

export function createWorkspace(definition: WorkspaceDefinition): Workspace {
  const store = getStore(definition)
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
    async open(options): Promise<WorkspaceSession> {
      const session: WorkspaceSession = {
        readFile: workspace.readFile,
        writeFile: workspace.writeFile,
        list: workspace.list,
        glob: workspace.glob,
        search: workspace.search,
        diff: workspace.diff,
      }
      if (options?.runtime === "local") {
        const { execLocal } = await import("./runtimes/local.ts")
        session.exec = execLocal
      }
      return session
    },
    mount(options?: WorkspaceMountOptions): WorkspaceMount {
      const mode = options?.mode || "read-only"
      return {
        workspace,
        mode,
        target: options?.target || "/workspace",
        async diff() {
          return await workspace.diff()
        },
        async commit() {
          await workspace.snapshot({ name: "mount-commit" })
        },
        async export() {
          return await workspace.snapshot({ name: "mount-export" })
        },
      }
    },
  }

  return workspace
}
