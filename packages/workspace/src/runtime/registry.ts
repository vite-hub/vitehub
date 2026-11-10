import runtimeRegistry from "#vitehub-workspace-registry"

import type { WorkspaceDefinitionInput } from "../core/types.ts"

export { setWorkspaceRuntimeConfig } from "./config.ts"

export type WorkspaceRegistryModule = {
  default?: WorkspaceDefinitionInput
}

export type WorkspaceRegistry = Record<string, () => Promise<WorkspaceRegistryModule>>

// The generated Nitro plugin imports this module at server startup, so it must not import the Workspace core.
// `version` tells the core registry to drop definitions that it loaded from an older registry.
const workspaceRuntimeRegistryKey = Symbol.for("vitehub.workspace.runtimeRegistry")

interface WorkspaceRuntimeRegistryState {
  loaders: WorkspaceRegistry
  version: number
}

type WorkspaceRuntimeRegistryGlobal = typeof globalThis & Record<symbol, WorkspaceRuntimeRegistryState | undefined>

export function workspaceRuntimeRegistryState(): Readonly<WorkspaceRuntimeRegistryState> {
  const scope = globalThis as WorkspaceRuntimeRegistryGlobal
  return scope[workspaceRuntimeRegistryKey] ??= { loaders: runtimeRegistry, version: 0 }
}

export function setWorkspaceRuntimeRegistry(registry: WorkspaceRegistry): void {
  const scope = globalThis as WorkspaceRuntimeRegistryGlobal
  scope[workspaceRuntimeRegistryKey] = { loaders: registry, version: workspaceRuntimeRegistryState().version + 1 }
}

export function resetWorkspaceRuntimeRegistry(): void {
  setWorkspaceRuntimeRegistry(runtimeRegistry)
}
