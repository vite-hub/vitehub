import { WorkspaceNotFoundError } from "./errors.ts"
import type { Workspace, WorkspaceDefinition } from "./types.ts"
import { createWorkspace } from "./workspace.ts"
import runtimeRegistry from "#vitehub-workspace-registry"

export type WorkspaceRegistryModule = {
  default?: WorkspaceDefinition
}

export type WorkspaceRegistry = Record<string, () => Promise<WorkspaceRegistryModule>>

const definitions = new Map<string, WorkspaceDefinition>()
let loaders: WorkspaceRegistry = runtimeRegistry

export function registerWorkspace(definition: WorkspaceDefinition): void {
  definitions.set(definition.name, definition)
}

export function setWorkspaceRegistry(registry: WorkspaceRegistry): void {
  loaders = registry
}

async function resolveWorkspaceDefinition(name: string): Promise<WorkspaceDefinition> {
  const existing = definitions.get(name)
  if (existing) return existing

  const load = loaders[name]
  if (!load) throw new WorkspaceNotFoundError(name)
  const mod = await load()
  const definition = mod.default
  if (!definition) throw new WorkspaceNotFoundError(name)
  if (definition.name !== name) {
    throw new TypeError(`[vitehub] Workspace definition "${name}" must declare name ${JSON.stringify(name)}.`)
  }
  registerWorkspace(definition)
  return definition
}

export async function useRegisteredWorkspace(name: string): Promise<Workspace> {
  const definition = await resolveWorkspaceDefinition(name)
  return createWorkspace(definition)
}
