import { WorkspaceNotFoundError } from "./errors.ts"
import type { Workspace, WorkspaceDefinition, WorkspaceDefinitionInput } from "./types.ts"
import { createWorkspace } from "./workspace.ts"
import runtimeRegistry from "#vitehub-workspace-registry"

export type WorkspaceRegistryModule = {
  default?: WorkspaceDefinitionInput
}

export type WorkspaceRegistry = Record<string, () => Promise<WorkspaceRegistryModule>>

const definitions = new Map<string, WorkspaceDefinition>()
let loaders: WorkspaceRegistry = runtimeRegistry

function normalizeWorkspaceDefinition(name: string, definition: WorkspaceDefinitionInput | undefined): WorkspaceDefinition {
  if (!definition) throw new WorkspaceNotFoundError(name)
  if ("name" in definition) {
    throw new TypeError(`[vitehub] Workspace definition "${name}" must not declare a name. Workspace names are inferred from filenames.`)
  }
  return { ...definition, name }
}

export function registerWorkspace(name: string, definition: WorkspaceDefinitionInput): void {
  if (!name || typeof name !== "string") {
    throw new TypeError("[vitehub] registerWorkspace requires a string name.")
  }
  definitions.set(name, normalizeWorkspaceDefinition(name, definition))
}

export function setWorkspaceRegistry(registry: WorkspaceRegistry): void {
  loaders = registry
}

export function resetWorkspaceRegistry(): void {
  loaders = runtimeRegistry
}

async function resolveWorkspaceDefinition(name: string): Promise<WorkspaceDefinition> {
  const existing = definitions.get(name)
  if (existing) return existing

  const load = loaders[name]
  if (!load) throw new WorkspaceNotFoundError(name)
  const mod = await load()
  const definition = normalizeWorkspaceDefinition(name, mod.default)
  definitions.set(name, definition)
  return definition
}

export async function useRegisteredWorkspace(name: string): Promise<Workspace> {
  const definition = await resolveWorkspaceDefinition(name)
  return createWorkspace(definition)
}
