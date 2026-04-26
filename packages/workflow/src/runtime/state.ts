import { AsyncLocalStorage } from "node:async_hooks"

import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"

const RUNS_LIMIT = 1024

let runtimeConfig: false | ResolvedWorkflowOptions | undefined
let runtimeRegistry: WorkflowDefinitionRegistry | undefined
let fallbackEvent: unknown
const eventStorage = new AsyncLocalStorage<unknown>()
const runs = new Map<string, unknown>()

export function setWorkflowRuntimeConfig(config: false | ResolvedWorkflowOptions | undefined): void {
  runtimeConfig = config
}

export function getWorkflowRuntimeConfig(): false | ResolvedWorkflowOptions | undefined {
  return runtimeConfig
}

export function setWorkflowRuntimeRegistry(registry: WorkflowDefinitionRegistry | undefined): void {
  runtimeRegistry = registry
}

export function getWorkflowRuntimeRegistry(): WorkflowDefinitionRegistry | undefined {
  return runtimeRegistry
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
  const entry = runtimeRegistry?.[name]
  if (!entry) {
    return undefined
  }
  const loaded = await entry()
  return ("default" in loaded ? loaded.default : loaded) as WorkflowDefinition | undefined
}

export function setWorkflowRun(id: string, run: unknown): void {
  if (runs.size >= RUNS_LIMIT) {
    const oldest = runs.keys().next().value
    if (oldest !== undefined) runs.delete(oldest)
  }
  runs.set(id, run)
}

export function getWorkflowRunState(id: string): unknown {
  const run = runs.get(id)
  if (run !== undefined) runs.delete(id)
  return run
}

export function resetWorkflowRuntime(): void {
  runtimeConfig = undefined
  runtimeRegistry = undefined
  fallbackEvent = undefined
  runs.clear()
}
