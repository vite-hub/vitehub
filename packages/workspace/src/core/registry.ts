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
  loadingDefinitions: Map<string, {
    consumers: number
    generation: number
    load: WorkspaceRegistry[string]
    promise: Promise<WorkspaceDefinition>
  }>
  loadGenerations: Map<string, number>
  loadedDefinitions: Map<string, WorkspaceDefinition>
  loaders: WorkspaceRegistry
  registeredDefinitions: Map<string, WorkspaceDefinition>
}

type WorkspaceRegistryGlobal = typeof globalThis & Record<symbol, WorkspaceRegistryState | undefined>

function workspaceRegistryState(): WorkspaceRegistryState {
  const scope = globalThis as WorkspaceRegistryGlobal
  scope[workspaceRegistryStateKey] ??= {
    loadingDefinitions: new Map(),
    loadGenerations: new Map<string, number>(),
    loadedDefinitions: new Map<string, WorkspaceDefinition>(),
    loaders: runtimeRegistry,
    registeredDefinitions: new Map<string, WorkspaceDefinition>(),
  }
  scope[workspaceRegistryStateKey].loadingDefinitions ??= new Map()
  scope[workspaceRegistryStateKey].loadGenerations ??= new Map<string, number>()
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
  invalidateWorkspaceLoads(state)
  state.loaders = registry
  state.loadedDefinitions.clear()
}

export function resetWorkspaceRegistry(): void {
  const state = workspaceRegistryState()
  invalidateWorkspaceLoads(state)
  state.loaders = runtimeRegistry
  state.loadedDefinitions.clear()
}

function invalidateWorkspaceLoads(state: WorkspaceRegistryState): void {
  for (const [name, loading] of state.loadingDefinitions) {
    if (state.loadGenerations.get(name) === loading.generation) {
      state.loadGenerations.set(name, loading.generation + 1)
    }
  }
  state.loadingDefinitions.clear()
}

async function resolveWorkspaceDefinition(name: string, abortSignal?: AbortSignal): Promise<WorkspaceDefinition> {
  const state = workspaceRegistryState()
  const existing = state.registeredDefinitions.get(name) || state.loadedDefinitions.get(name)
  if (existing) return existing

  const load = state.loaders[name]
  if (!load) throw workspaceNotFoundError(name)

  let loading = state.loadingDefinitions.get(name)
  if (!loading || loading.load !== load) {
    const generation = (state.loadGenerations.get(name) ?? 0) + 1
    state.loadGenerations.set(name, generation)
    const promise = load().then((mod) => {
      const definition = normalizeWorkspaceDefinition(name, mod.default)
      if (state.loadGenerations.get(name) === generation && state.loaders[name] === load) {
        state.loadedDefinitions.set(name, definition)
      }
      return definition
    })
    loading = { consumers: 0, generation, load, promise }
    state.loadingDefinitions.set(name, loading)
    void promise.finally(() => {
      if (state.loadingDefinitions.get(name) === loading) state.loadingDefinitions.delete(name)
    }).catch(() => {})
  }

  loading.consumers++
  let aborted = false
  let rejectAbort!: (reason?: unknown) => void
  const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    aborted = true
    rejectAbort(abortSignal?.reason)
  }
  if (abortSignal?.aborted) onAbort()
  else abortSignal?.addEventListener("abort", onAbort, { once: true })
  try {
    if (!abortSignal) return await loading.promise
    return await Promise.race([loading.promise, abort])
  }
  finally {
    abortSignal?.removeEventListener("abort", onAbort)
    loading.consumers--
    if (aborted && loading.consumers === 0 && state.loadingDefinitions.get(name) === loading) {
      state.loadingDefinitions.delete(name)
      if (state.loadGenerations.get(name) === loading.generation) {
        state.loadGenerations.set(name, loading.generation + 1)
      }
    }
  }
}

export async function resolveRegisteredWorkspaceDefinition(name: string, abortSignal?: AbortSignal): Promise<WorkspaceDefinition> {
  return resolveWorkspaceDefinition(name, abortSignal)
}

export async function useRegisteredWorkspace(name: string): Promise<Workspace> {
  const definition = await resolveWorkspaceDefinition(name)
  return createWorkspace(definition)
}
