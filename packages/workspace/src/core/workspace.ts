import { createBasicWorkspaceSession } from "../session/basic.ts"
import { attachWorkspaceSourceRequestExecution, createWorkspaceSourceRequestExecution } from "../sources/request-execution.ts"
import { createWorkspaceSourceView } from "../sources/view.ts"
import { createWorkspaceStoreFromProvider } from "../storage/provider.ts"
import { getCachedWorkspaceStore } from "./workspace-cache.ts"
import type {
  Workspace,
  WorkspaceDefinition,
  WorkspaceMount,
  WorkspaceMountOptions,
  WorkspaceSession,
} from "./types.ts"

type WorkspaceWithDefinitionSync = Workspace & {
  __syncWorkspaceDefinition?: () => Promise<void>
}

function getStore(definition: WorkspaceDefinition) {
  return getCachedWorkspaceStore(definition, () => createWorkspaceStoreFromProvider(definition))
}

export function createWorkspace(definition: WorkspaceDefinition): Workspace {
  const store = getStore(definition)
  const files = createWorkspaceSourceView(definition, store)

  const workspace: Workspace = {
    name: definition.name,
    async sync(options) {
      const { syncWorkspaceSources } = await import("../sources/sync.ts")
      return await syncWorkspaceSources(definition, store, options)
    },
    async materializeSources(options) {
      return await files.materializeSources(options)
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
      const snapshot = await store.snapshot(options)
      const { publishWorkspaceSnapshot } = await import("../lifecycle.ts")
      await publishWorkspaceSnapshot(definition, store, snapshot)
      return snapshot
    },
    async diff(options) {
      return await store.diff(options)
    },
    async startSession(options): Promise<WorkspaceSession> {
      if (definition.runtime === "sandbox") {
        const { createSandboxWorkspaceSession } = await import("../session/sandbox.ts")
        return await createSandboxWorkspaceSession(definition, workspace, options)
      }
      if (definition.runtime === "trusted-host") {
        const { createTrustedHostWorkspaceSession } = await import("../session/trusted-host.ts")
        return await createTrustedHostWorkspaceSession(definition, workspace, options)
      }

      return createBasicWorkspaceSession(workspace)
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

  ;(workspace as WorkspaceWithDefinitionSync).__syncWorkspaceDefinition = async () => {
    const { syncWorkspaceDefinition } = await import("../lifecycle.ts")
    await syncWorkspaceDefinition(definition, store)
  }

  return attachWorkspaceSourceRequestExecution(workspace, createWorkspaceSourceRequestExecution(definition))
}
