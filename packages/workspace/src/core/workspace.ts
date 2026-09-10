import { createBasicWorkspaceSession } from "../session/basic.ts"
import { attachWorkspaceSourceRequestExecution, createWorkspaceSourceRequestExecution } from "../sources/request-execution.ts"
import { normalizeWorkspaceSources } from "../sources/config.ts"
import { createWorkspaceSourceView } from "../sources/view.ts"
import { materializedFileMatches, readCurrentSourceSnapshot } from "../sources/materialization.ts"
import { fileAttributesUnavailable } from "../internal/file-attributes.ts"
import { createWorkspaceStoreFromProvider } from "../storage/provider.ts"
import { forwardWorkspaceRevisionMaterializer } from "../storage/materialization.ts"
import { forwardWorkspaceStoreTarget } from "../storage/target.ts"
import { workspaceMetadataTarget } from "../storage/metadata-target.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"
import { getCachedWorkspaceStore } from "./workspace-cache.ts"
import type {
  Workspace,
  WorkspaceDefinition,
  WorkspaceDiff,
  WorkspaceSession,
  WorkspaceStore,
} from "./types.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

type WorkspaceWithDefinitionSync = Workspace & {
  __workspaceDefinitionSyncKey?: object
  __syncWorkspaceDefinition?: (abortSignal?: AbortSignal) => Promise<void>
}

function getStore(definition: WorkspaceDefinition) {
  return getCachedWorkspaceStore(definition, () => createWorkspaceStoreFromProvider(definition))
}

async function filterStartupSourceChanges(definition: WorkspaceDefinition, store: WorkspaceStore, diff: WorkspaceDiff): Promise<WorkspaceDiff> {
  if (!diff.entries.length) return diff
  const generatedFiles = new Set<string>()
  const generatedDirectories = new Set<string>()
  for (const source of normalizeWorkspaceSources(definition.sources)) {
    if (source.materialize !== "startup") continue
    const snapshot = await readCurrentSourceSnapshot(store, source)
    if (snapshot?.status !== "ready") continue
    for (const [path, item] of Object.entries(snapshot.items || {})) {
      try {
        if ((await store.stat(path))?.type !== "file") continue
        const file = await store.readFile(path)
        if (file && (file.metadata?.source === source.key || fileAttributesUnavailable(file))
          && await materializedFileMatches(file, item)) generatedFiles.add(path)
      }
      catch (error) {
        // A replaced ancestor makes the indexed file unavailable, not generated.
        if (error && hasRuntimeType(error, "object") && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue
        throw error
      }
    }
    for (const path of [...(snapshot.ownedDirectories || []), ...(snapshot.ownedAncestors || []), ...(snapshot.ownsMount ? [source.mountPath] : [])]) {
      generatedDirectories.add(path)
    }
  }
  const entries: WorkspaceDiff["entries"] = []
  for (const entry of diff.entries) {
    if (entry.after?.type === "file" && generatedFiles.has(entry.path)) continue
    if (entry.type === "added" && entry.after?.type === "directory" && generatedDirectories.has(entry.path)) {
      const descendants = await store.list(entry.path, { recursive: true })
      if (descendants.every(child => child.type === "directory"
        ? generatedDirectories.has(child.path)
        : generatedFiles.has(child.path))) continue
    }
    entries.push(entry)
  }
  return { ...diff, entries }
}

export function createWorkspace(definition: WorkspaceDefinition, options: { reuseStartupSnapshots?: boolean } = {}): Workspace {
  const store = getStore(definition)
  const files = createWorkspaceSourceView(definition, store, options)

  const workspace: Workspace & { [workspaceMetadataTarget]: () => WorkspaceStore } = {
    [workspaceMetadataTarget]: () => store,
    name: definition.name,
    async capabilities() {
      return { conditionalWrites: hasRuntimeType(store.writeFileConditional, "function") }
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
    async rebase(options) {
      if (!store.rebase) throw workspaceErrorDiagnostics.WORKSPACE_R0026({ message: "[vitehub] Workspace Store does not support rebasing." })
      await store.rebase(options)
    },
    async diff(options) {
      const diff = await store.diff(options)
      // Explicit historical comparisons retain the Store's complete snapshot diff.
      return options?.from ? diff : await filterStartupSourceChanges(definition, store, diff)
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
  if (!normalizeWorkspaceSources(definition.sources).some(source => source.requestDescriptor || source.livePaths)) {
    forwardWorkspaceRevisionMaterializer(store, workspace)
  }

  // SAFETY: This module owns the private synchronization member attached to its Workspace facade.
  const synchronizedWorkspace = workspace as WorkspaceWithDefinitionSync
  synchronizedWorkspace.__workspaceDefinitionSyncKey = definition
  synchronizedWorkspace.__syncWorkspaceDefinition = async (abortSignal) => {
    const { syncWorkspaceDefinition } = await import("../lifecycle.ts")
    await syncWorkspaceDefinition(definition, store, abortSignal)
  }

  return attachWorkspaceSourceRequestExecution(workspace, createWorkspaceSourceRequestExecution(definition))
}
