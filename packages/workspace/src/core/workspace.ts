import { createBasicWorkspaceSession } from "../session/basic.ts"
import { attachWorkspaceSourceRequestExecution, createWorkspaceSourceRequestExecution } from "../sources/request-execution.ts"
import { createWorkspaceSourceView } from "../sources/view.ts"
import { createWorkspaceStoreFromProvider } from "../storage/provider.ts"
import { forwardWorkspaceStoreTarget } from "../storage/target.ts"
import { getCachedWorkspaceStore } from "./workspace-cache.ts"
import type {
  Workspace,
  WorkspaceDefinition,
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
    async capabilities() {
      return { conditionalWrites: typeof store.writeFileConditional === "function" }
    },
    async sync(options) {
      const { syncWorkspaceSources } = await import("../sources/sync.ts")
      return await syncWorkspaceSources(definition, store, options)
    },
    async materializeSources(options) {
      return await files.materializeSources(options)
    },
    async getMeta(key) {
      return await store.getMeta?.(key)
    },
    async setMeta(key, value) {
      await store.setMeta?.(key, value)
    },
    async readFile(path, options) {
      return await files.readFile(path, options)
    },
    async writeFile(path, content, options) {
      return await files.writeFile(path, content, options)
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
    async publish(options) {
      const { publishWorkspace } = await import("../lifecycle.ts")
      await publishWorkspace(definition, store, options)
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
      const host = options?.host
      if (host) {
        const { createHostedWorkspaceSession } = await import("../session/host.ts")
        return await createHostedWorkspaceSession(workspace, { ...options, host })
      }

      return await createBasicWorkspaceSession(workspace, options)
    },
  }

  forwardWorkspaceStoreTarget(store, workspace)

  ;(workspace as WorkspaceWithDefinitionSync).__syncWorkspaceDefinition = async () => {
    const { syncWorkspaceDefinition } = await import("../lifecycle.ts")
    await syncWorkspaceDefinition(definition, store)
  }

  return attachWorkspaceSourceRequestExecution(workspace, createWorkspaceSourceRequestExecution(definition))
}
