import { AsyncLocalStorage } from "node:async_hooks"

import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"

const RUNS_LIMIT = 1024
const RUNS_TTL_MS = 5 * 60 * 1000

let runtimeConfig: false | ResolvedWorkflowOptions | undefined
let runtimeRegistry: WorkflowDefinitionRegistry | undefined
const inlineRegistry = new Map<string, WorkflowDefinition>()
const loadingRegistryEntries = new Map<string, Promise<WorkflowDefinition | undefined>>()
const loadedRegistryEntries = new Map<string, WorkflowDefinition | undefined>()
let fallbackEvent: unknown
const eventStorage = new AsyncLocalStorage<unknown>()
const loadingRegistryStorage = new AsyncLocalStorage<Set<string>>()

export interface WorkflowRunState<TResult = unknown> {
  error?: unknown
  expiresAt?: number
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>
  result?: TResult
  status: "running" | "completed" | "failed"
}

const runs = new Map<string, WorkflowRunState>()

function getRunKey(name: string, id: string): string {
  return `${name}\0${id}`
}

function pruneWorkflowRuns(): void {
  const now = Date.now()
  for (const [key, run] of runs) {
    if (run.expiresAt && run.expiresAt <= now) {
      runs.delete(key)
    }
  }
}

export function setWorkflowRuntimeConfig(config: false | ResolvedWorkflowOptions | undefined): void {
  runtimeConfig = config
}

export function getWorkflowRuntimeConfig(): false | ResolvedWorkflowOptions | undefined {
  return runtimeConfig
}

export function setWorkflowRuntimeRegistry(registry: WorkflowDefinitionRegistry | undefined): void {
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
  return definition
}

export function registerInlineWorkflowDefinition(name: string, definition: WorkflowDefinition): void {
  if (!name || typeof name !== "string") {
    throw new TypeError("`createWorkflow()` requires a workflow name.")
  }

  const existing = inlineRegistry.get(name)
  if (existing && existing !== definition) {
    throw new Error(`Duplicate workflow name "${name}" from inline definitions.`)
  }

  inlineRegistry.set(name, definition)
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
  const inlineDefinition = inlineRegistry.get(name)
  const entry = runtimeRegistry?.[name]

  if (entry && loadedRegistryEntries.has(name)) {
    return loadedRegistryEntries.get(name)
  }

  if (inlineDefinition) {
    if (entry) {
      throw new Error(`Duplicate workflow name "${name}" from inline and discovered definitions.`)
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
    const loaded = await entry()
    const registeredInlineDefinition = inlineRegistry.get(name)
    if (registeredInlineDefinition) {
      return registeredInlineDefinition
    }
    if (!loaded || typeof loaded !== "object") {
      return undefined
    }
    const definition = ("default" in loaded ? loaded.default : loaded) as WorkflowDefinition | undefined
    return definition && typeof definition.handler === "function" ? definition : undefined
  }))
  loadingRegistryEntries.set(name, loadingEntry)
  try {
    const loaded = await loadingEntry
    loadedRegistryEntries.set(name, loaded)
    return loaded
  }
  finally {
    loadingRegistryEntries.delete(name)
  }
}

export function setWorkflowRun<TResult = unknown>(
  name: string,
  id: string,
  promise: Promise<{ result?: TResult, status: "completed" | "failed", error?: unknown }>,
): WorkflowRunState<TResult> {
  pruneWorkflowRuns()
  if (runs.size >= RUNS_LIMIT) {
    const oldest = runs.keys().next().value
    if (oldest !== undefined) runs.delete(oldest)
  }
  const state: WorkflowRunState<TResult> = {
    promise: promise.then((resolved) => {
      state.status = resolved.status
      state.result = resolved.result
      state.error = resolved.error
      state.expiresAt = Date.now() + RUNS_TTL_MS
      return resolved
    }),
    status: "running",
  }
  runs.set(getRunKey(name, id), state)
  return state
}

export function getWorkflowRunState(name: string, id: string): WorkflowRunState | undefined {
  pruneWorkflowRuns()
  return runs.get(getRunKey(name, id))
}

export function resetWorkflowRuntime(): void {
  runtimeConfig = undefined
  runtimeRegistry = undefined
  inlineRegistry.clear()
  loadingRegistryEntries.clear()
  loadedRegistryEntries.clear()
  fallbackEvent = undefined
  runs.clear()
}
