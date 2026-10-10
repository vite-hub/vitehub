import { AsyncLocalStorage } from "node:async_hooks"

import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

const RUNS_LIMIT = 1024
const RUNS_TTL_MS = 5 * 60 * 1000

let runtimeConfig: false | ResolvedWorkflowOptions | undefined
let runtimeRegistry: WorkflowDefinitionRegistry | undefined
const inlineRegistry = new Map<string, WorkflowDefinition>()
const loadingRegistryEntries = new Map<string, Promise<WorkflowDefinition | undefined>>()
const loadedRegistryEntries = new Map<string, WorkflowDefinition | undefined>()
let runtimeRegistryGeneration = 0
let fallbackEvent: unknown
const eventStorage = new AsyncLocalStorage<unknown>()
const loadingRegistryStorage = new AsyncLocalStorage<Set<string>>()
const loadingInlineRegistryStorage = new AsyncLocalStorage<Map<string, WorkflowDefinition>>()
const loadingGenerationStorage = new AsyncLocalStorage<number>()

export interface WorkflowRunState<TResult = unknown> {
  error?: unknown
  expiresAt?: number
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>
  result?: TResult
  status: "running" | "completed" | "failed"
}

// Execution retains its state through the completion callback. When GC APIs
// exist, inspection does not keep an abandoned promise and its payload alive.
type ActiveRunReference = WeakRef<WorkflowRunState> | WorkflowRunState
const runs = new Map<string, ActiveRunReference>()
// Without GC APIs, bound strong inspection ownership independently of history.
const fallbackRunKeys = new Set<string>()
let collectedRuns: FinalizationRegistry<{ key: string, reference: WeakRef<WorkflowRunState> }> | undefined
const completedRuns = new Map<string, WorkflowRunState>()

function isWeakReference(reference: ActiveRunReference): reference is WeakRef<WorkflowRunState> {
  return reference !== null && "deref" in reference
}

function getRunKey(name: string, id: string): string {
  return JSON.stringify([name, id])
}

function pruneWorkflowRuns(): void {
  const now = Date.now()
  for (const [key, run] of completedRuns) {
    if (run.expiresAt && run.expiresAt <= now) {
      completedRuns.delete(key)
    }
  }
  while (completedRuns.size > RUNS_LIMIT) {
    completedRuns.delete(completedRuns.keys().next().value!)
  }
}

export function setWorkflowRuntimeConfig(config: false | ResolvedWorkflowOptions | undefined): void {
  runtimeConfig = config
}

export function getWorkflowRuntimeConfig(): false | ResolvedWorkflowOptions | undefined {
  return runtimeConfig
}

export function setWorkflowRuntimeRegistry(registry: WorkflowDefinitionRegistry | undefined): void {
  if (runtimeRegistry !== registry) loadingRegistryEntries.clear()
  runtimeRegistryGeneration++
  runtimeRegistry = registry
  loadedRegistryEntries.clear()
}

export function getWorkflowRuntimeRegistry(): WorkflowDefinitionRegistry | undefined {
  return runtimeRegistry
}

export function getInlineWorkflowDefinitions(): ReadonlyMap<string, WorkflowDefinition> {
  return inlineRegistry
}

export function takeInlineWorkflowDefinition(name: string): WorkflowDefinition | undefined {
  const definition = inlineRegistry.get(name)
  inlineRegistry.delete(name)
  loadingInlineRegistryStorage.getStore()?.delete(name)
  return definition
}

function isWorkflowHandle(value: unknown): value is { name: string } {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow modules cross an untyped loader boundary and require structural runtime checks.
  if (typeof value !== "object" || value === null) return false

  // SAFETY: The object and null checks above establish the loader value shape.
  const candidate = value as {
    name?: unknown
    defer?: unknown
    getRun?: unknown
    run?: unknown
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow modules cross an untyped loader boundary and require structural runtime checks.
  if (typeof candidate.name !== "string") return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow modules cross an untyped loader boundary and require structural runtime checks.
  if (typeof candidate.defer !== "function") return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow modules cross an untyped loader boundary and require structural runtime checks.
  if (typeof candidate.getRun !== "function") return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Workflow modules cross an untyped loader boundary and require structural runtime checks.
  return typeof candidate.run === "function"
}

function findExportedInlineWorkflowDefinition(
  name: string,
  loaded: unknown,
  definitions: ReadonlyMap<string, WorkflowDefinition>,
): { definition: WorkflowDefinition, name: string } | undefined {
  const namedDefinition = definitions.get(name)
  if (namedDefinition) return { definition: namedDefinition, name }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Loaded module values are opaque until their object shape is checked.
  if (!loaded || typeof loaded !== "object") return undefined

  if ("default" in loaded && isWorkflowHandle(loaded.default)) {
    const definition = definitions.get(loaded.default.name)
    if (definition) return { definition, name: loaded.default.name }
  }

  const matches = new Map<string, WorkflowDefinition>()
  for (const value of Object.values(loaded)) {
    if (!isWorkflowHandle(value)) continue
    const definition = definitions.get(value.name)
    if (definition) matches.set(value.name, definition)
  }

  if (matches.size !== 1) return undefined
  // doctor-disable-next-line typescript/strict/require-safety-comment-for-type-assertion -- A non-empty map has a first entry.
  const [matchedName, definition] = matches.entries().next().value!
  return { definition, name: matchedName }
}

export function takeInlineWorkflowDefinitionForModule(name: string, loaded: unknown): WorkflowDefinition | undefined {
  const match = findExportedInlineWorkflowDefinition(name, loaded, inlineRegistry)
  if (!match) return undefined
  inlineRegistry.delete(match.name)
  return match.definition
}

function consumeInlineWorkflowDefinition(name: string, expected?: WorkflowDefinition): WorkflowDefinition | undefined {
  const definition = inlineRegistry.get(name)
  if (!expected || definition === expected) {
    inlineRegistry.delete(name)
  }
  return definition
}

export function registerInlineWorkflowDefinition(name: string, definition: WorkflowDefinition): void {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Public Workflow names cross an untyped API boundary.
  if (!name || typeof name !== "string") {
    throw workflowErrorDiagnostics.WORKFLOW_R0023({ message: "`createWorkflow()` requires a workflow name." })
  }

  const loadingDefinitions = loadingInlineRegistryStorage.getStore()
  const loadingGeneration = loadingGenerationStorage.getStore()
  const existing = inlineRegistry.get(name)
  if (existing && existing !== definition) {
    if (!loadingDefinitions) {
      throw workflowErrorDiagnostics.WORKFLOW_R0024({ message: `Duplicate workflow name "${name}" from inline definitions.` })
    }
  }
  if (loadingGeneration === undefined || loadingGeneration === runtimeRegistryGeneration) {
    inlineRegistry.set(name, definition)
  }

  loadingDefinitions?.set(name, definition)
}

export function enterWorkflowRuntimeEvent(event: unknown): void {
  fallbackEvent = event
  try {
    eventStorage.enterWith(event)
  }
  catch {}
}

export function getWorkflowRuntimeEvent(): unknown {
  return eventStorage.getStore() ?? fallbackEvent
}

export async function runWithWorkflowRuntimeEvent<T>(event: unknown, run: () => T | Promise<T>): Promise<T> {
  return await eventStorage.run(event, run)
}

export async function loadWorkflowDefinition(name: string): Promise<WorkflowDefinition | undefined> {
  const generation = runtimeRegistryGeneration
  const inlineDefinition = inlineRegistry.get(name)
  const entry = runtimeRegistry && Object.hasOwn(runtimeRegistry, name) ? runtimeRegistry[name] : undefined

  if (entry && loadedRegistryEntries.has(name)) {
    return loadedRegistryEntries.get(name)
  }

  if (inlineDefinition) {
    if (entry) {
      throw workflowErrorDiagnostics.WORKFLOW_R0025({ message: `Duplicate workflow name "${name}" from inline and discovered definitions.` })
    }
    return inlineDefinition
  }

  if (!entry) {
    return undefined
  }

  const activeLoads = loadingRegistryStorage.getStore()
  const inFlightEntry = loadingRegistryEntries.get(name)
  if (inFlightEntry) {
    return activeLoads?.has(name) ? undefined : await inFlightEntry
  }

  const nextActiveLoads = new Set(activeLoads)
  nextActiveLoads.add(name)
  const loadingEntry = Promise.resolve().then(() => loadingRegistryStorage.run(nextActiveLoads, async () => {
    const loadingInlineDefinitions = new Map<string, WorkflowDefinition>()
    let loaded: unknown
    try {
      loaded = await loadingGenerationStorage.run(generation, () => loadingInlineRegistryStorage.run(loadingInlineDefinitions, entry))
    }
    catch (error) {
      // A failed module load must not leave definitions registered by that
      // module available to a later load. Keep definitions from a newer
      // generation or concurrent load intact.
      for (const [definitionName, definition] of loadingInlineDefinitions) {
        if (inlineRegistry.get(definitionName) === definition) inlineRegistry.delete(definitionName)
      }
      throw error
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry loaders return opaque module values.
    if (!loaded || typeof loaded !== "object") {
      return undefined
    }
    const registeredInlineDefinition = loadingInlineDefinitions.get(name)
      ?? (generation === runtimeRegistryGeneration ? consumeInlineWorkflowDefinition(name) : undefined)
    if (registeredInlineDefinition) {
      consumeInlineWorkflowDefinition(name, registeredInlineDefinition)
      return registeredInlineDefinition
    }
    // SAFETY: Registry module exports are validated as WorkflowDefinitions at this boundary.
    const definition = ("default" in loaded ? loaded.default : loaded) as WorkflowDefinition | undefined
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry module exports are opaque until their handler shape is checked.
    if (definition && typeof definition.handler === "function") {
      return definition
    }
    const exportedInlineDefinition = findExportedInlineWorkflowDefinition(name, loaded, loadingInlineDefinitions)
    if (!exportedInlineDefinition) return undefined
    consumeInlineWorkflowDefinition(exportedInlineDefinition.name, exportedInlineDefinition.definition)
    return exportedInlineDefinition.definition
  }))
  loadingRegistryEntries.set(name, loadingEntry)
  try {
    const loaded = await loadingEntry
    if (generation === runtimeRegistryGeneration && loadingRegistryEntries.get(name) === loadingEntry) {
      loadedRegistryEntries.set(name, loaded)
    }
    return loaded
  }
  finally {
    if (loadingRegistryEntries.get(name) === loadingEntry) {
      loadingRegistryEntries.delete(name)
    }
  }
}

export function setWorkflowRun<TResult = unknown>(
  name: string,
  id: string,
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>,
): WorkflowRunState<TResult> {
  pruneWorkflowRuns()
  const key = getRunKey(name, id)
  const canUseWeakReferences = globalThis.WeakRef !== undefined && globalThis.FinalizationRegistry !== undefined
  if (canUseWeakReferences) {
    collectedRuns ??= new FinalizationRegistry(({ key, reference }) => {
      if (runs.get(key) === reference) runs.delete(key)
    })
  }
  const previous = runs.get(key)
  if (previous && canUseWeakReferences) collectedRuns?.unregister(previous)
  fallbackRunKeys.delete(key)
  completedRuns.delete(key)
  const state: WorkflowRunState<TResult> = {
    promise: promise.then((resolved) => {
      state.status = resolved.status
      state.result = resolved.result
      state.error = resolved.error
      state.expiresAt = Date.now() + RUNS_TTL_MS
      const active = runs.get(key)
      const activeState = active && isWeakReference(active) ? active.deref() : active
      if (activeState === state) {
        runs.delete(key)
        fallbackRunKeys.delete(key)
        if (isWeakReference(reference)) collectedRuns?.unregister(reference)
        completedRuns.set(key, state)
        pruneWorkflowRuns()
      }
      return resolved
    }),
    status: "running",
  }
  const reference: ActiveRunReference = canUseWeakReferences ? new WeakRef(state) : state
  runs.set(key, reference)
  if (isWeakReference(reference)) collectedRuns?.register(state, { key, reference }, reference)
  else {
    fallbackRunKeys.add(key)
    while (fallbackRunKeys.size > RUNS_LIMIT) {
      const oldest = fallbackRunKeys.values().next().value!
      fallbackRunKeys.delete(oldest)
      runs.delete(oldest)
    }
  }
  return state
}

export function getWorkflowRunState(name: string, id: string): WorkflowRunState | undefined {
  pruneWorkflowRuns()
  const key = getRunKey(name, id)
  const reference = runs.get(key)
  const state = reference && isWeakReference(reference) ? reference.deref() : reference
  if (reference && !state) {
    runs.delete(key)
    if (isWeakReference(reference)) collectedRuns?.unregister(reference)
  }
  return state ?? completedRuns.get(key)
}

export function resetWorkflowRuntime(): void {
  runtimeRegistryGeneration++
  runtimeConfig = undefined
  runtimeRegistry = undefined
  inlineRegistry.clear()
  loadingRegistryEntries.clear()
  loadedRegistryEntries.clear()
  fallbackEvent = undefined
  for (const reference of runs.values()) {
    if (isWeakReference(reference)) collectedRuns?.unregister(reference)
  }
  runs.clear()
  fallbackRunKeys.clear()
  completedRuns.clear()
}
