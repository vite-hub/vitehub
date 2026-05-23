import { WorkspaceNotFoundError } from "./errors.ts"
import type { Workspace, WorkspaceDefinition, WorkspaceDefinitionInput } from "./types.ts"
import { createWorkspace } from "./workspace.ts"
import runtimeRegistry from "#vitehub-workspace-registry"

export type WorkspaceRegistryModule = {
  default?: WorkspaceDefinitionInput
}

export type WorkspaceRegistry = Record<string, () => Promise<WorkspaceRegistryModule>>

const registeredDefinitions = new Map<string, WorkspaceDefinition>()
const loadedDefinitions = new Map<string, WorkspaceDefinition>()
let loaders: WorkspaceRegistry = runtimeRegistry

function normalizeWorkspaceDefinition(name: string, definition: WorkspaceDefinitionInput | undefined): WorkspaceDefinition {
  if (!definition) throw new WorkspaceNotFoundError(name)
  const workspaceAgentOptions = (definition as { __vitehubWorkspaceAgentOptions?: { workspace?: string | WorkspaceDefinitionInput } }).__vitehubWorkspaceAgentOptions
  if (workspaceAgentOptions?.workspace) {
    return {
      ...(typeof workspaceAgentOptions.workspace === "string" ? {} : workspaceAgentOptions.workspace),
      name,
    }
  }
  if ("name" in definition) {
    throw new TypeError(`[vitehub] Workspace definition "${name}" must not declare a name. Workspace names are inferred from filenames.`)
  }
  const {
    __vitehubWorkspaceAgent: _agent,
    __vitehubWorkspaceAgentDefaults: _agentDefaults,
    __vitehubWorkspaceAgentOptions: _agentOptions,
    description: _description,
    fallback: _fallback,
    instructions: _instructions,
    model: _model,
    name: _agentName,
    resolve: _resolve,
    run: _run,
    stepLimit: _stepLimit,
    workspace: _workspace,
    ...workspace
  } = definition as WorkspaceDefinitionInput & Record<string, unknown>
  return { ...workspace, name }
}

export function registerWorkspace(name: string, definition: WorkspaceDefinitionInput): void {
  if (!name || typeof name !== "string") {
    throw new TypeError("[vitehub] registerWorkspace requires a string name.")
  }
  registeredDefinitions.set(name, normalizeWorkspaceDefinition(name, definition))
}

export function setWorkspaceRegistry(registry: WorkspaceRegistry): void {
  loaders = registry
  loadedDefinitions.clear()
}

export function resetWorkspaceRegistry(): void {
  loaders = runtimeRegistry
  loadedDefinitions.clear()
}

async function resolveWorkspaceDefinition(name: string): Promise<WorkspaceDefinition> {
  const existing = registeredDefinitions.get(name) || loadedDefinitions.get(name)
  if (existing) return existing

  const load = loaders[name]
  if (!load) throw new WorkspaceNotFoundError(name)
  const mod = await load()
  const definition = normalizeWorkspaceDefinition(name, mod.default)
  loadedDefinitions.set(name, definition)
  return definition
}

export async function useRegisteredWorkspace(name: string): Promise<Workspace> {
  const definition = await resolveWorkspaceDefinition(name)
  return createWorkspace(definition)
}
