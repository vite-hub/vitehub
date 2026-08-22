import { workspaceNotFoundError } from "./errors.ts"
import type { Workspace, WorkspaceDefinition, WorkspaceDefinitionInput } from "./types.ts"
import { createWorkspace } from "./workspace.ts"
import runtimeRegistry from "#vitehub-workspace-registry"

export type WorkspaceRegistryModule = {
  default?: WorkspaceDefinitionInput
}

export type WorkspaceRegistry = Record<string, () => Promise<WorkspaceRegistryModule>>

const workspaceRegistryStateKey = Symbol.for("vitehub.workspace.registryState")

interface WorkspaceRegistryState {
  loadedDefinitions: Map<string, WorkspaceDefinition>
  loaders: WorkspaceRegistry
  registeredDefinitions: Map<string, WorkspaceDefinition>
}

type WorkspaceRegistryGlobal = typeof globalThis & Record<symbol, WorkspaceRegistryState | undefined>

function workspaceRegistryState(): WorkspaceRegistryState {
  const scope = globalThis as WorkspaceRegistryGlobal
  scope[workspaceRegistryStateKey] ??= {
    loadedDefinitions: new Map<string, WorkspaceDefinition>(),
    loaders: runtimeRegistry,
    registeredDefinitions: new Map<string, WorkspaceDefinition>(),
  }
  return scope[workspaceRegistryStateKey]
}

function pickWorkspaceFields(definition: WorkspaceDefinitionInput | Record<string, unknown>): WorkspaceDefinitionInput {
  const {
    __vitehubWorkspaceAgent: _agent,
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
  return workspace
}

export function normalizeWorkspaceDefinition(name: string, definition: WorkspaceDefinitionInput | undefined): WorkspaceDefinition {
  if (!definition) throw workspaceNotFoundError(name)
  const workspaceAgentOptions = (definition as { __vitehubWorkspaceAgentOptions?: { workspace?: string | WorkspaceDefinitionInput } }).__vitehubWorkspaceAgentOptions
  if (workspaceAgentOptions?.workspace) {
    const injectedWorkspace = pickWorkspaceFields(definition)
    const configuredWorkspace = typeof workspaceAgentOptions.workspace === "string" ? {} : workspaceAgentOptions.workspace
    const sources = mergeWorkspaceSources(injectedWorkspace.sources, configuredWorkspace.sources)
    return {
      ...injectedWorkspace,
      ...configuredWorkspace,
      ...(sources ? { sources } : {}),
      rootDir: configuredWorkspace.rootDir ?? injectedWorkspace.rootDir,
      sourceRootDir: configuredWorkspace.sourceRootDir ?? injectedWorkspace.sourceRootDir,
      name,
    }
  }
  if ("name" in definition) {
    throw new TypeError(`[vitehub] Workspace definition "${name}" must not declare a name. Workspace names are inferred from filenames.`)
  }
  return { ...pickWorkspaceFields(definition), name }
}

function mergeWorkspaceSources(
  injected: WorkspaceDefinitionInput["sources"] | undefined,
  configured: WorkspaceDefinitionInput["sources"] | undefined,
): WorkspaceDefinitionInput["sources"] | undefined {
  if (!injected && !configured) return undefined
  return { ...injected, ...configured }
}

export function registerWorkspace(name: string, definition: WorkspaceDefinitionInput): WorkspaceDefinition {
  if (!name || typeof name !== "string") {
    throw new TypeError("[vitehub] registerWorkspace requires a string name.")
  }
  const registered = normalizeWorkspaceDefinition(name, definition)
  workspaceRegistryState().registeredDefinitions.set(name, registered)
  return registered
}

export function setWorkspaceRegistry(registry: WorkspaceRegistry): void {
  const state = workspaceRegistryState()
  state.loaders = registry
  state.loadedDefinitions.clear()
}

export function resetWorkspaceRegistry(): void {
  const state = workspaceRegistryState()
  state.loaders = runtimeRegistry
  state.loadedDefinitions.clear()
}

async function resolveWorkspaceDefinition(name: string): Promise<WorkspaceDefinition> {
  const state = workspaceRegistryState()
  const existing = state.registeredDefinitions.get(name) || state.loadedDefinitions.get(name)
  if (existing) return existing

  const load = state.loaders[name]
  if (!load) throw workspaceNotFoundError(name)
  const mod = await load()
  const definition = normalizeWorkspaceDefinition(name, mod.default)
  state.loadedDefinitions.set(name, definition)
  return definition
}

export async function resolveRegisteredWorkspaceDefinition(name: string): Promise<WorkspaceDefinition> {
  return resolveWorkspaceDefinition(name)
}

export async function useRegisteredWorkspace(name: string): Promise<Workspace> {
  const definition = await resolveWorkspaceDefinition(name)
  return createWorkspace(definition)
}
