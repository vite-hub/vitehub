import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"

let runtimeConfig: false | ResolvedWorkflowOptions | undefined
let runtimeEvent: unknown
let runtimeRegistry: WorkflowDefinitionRegistry | undefined
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
  runtimeEvent = event
}

export function getWorkflowRuntimeEvent(): unknown {
  return runtimeEvent
}

export async function runWithWorkflowRuntimeEvent<T>(event: unknown, run: () => T | Promise<T>): Promise<T> {
  const previous = runtimeEvent
  runtimeEvent = event
  try {
    return await run()
  }
  finally {
    runtimeEvent = previous
  }
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
  runs.set(id, run)
}

export function getWorkflowRunState(id: string): unknown {
  return runs.get(id)
}
