import { getOpenWorkflowRuntime, registerOpenWorkflowDefinition } from "./openworkflow.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"

type OpenWorkflowWorker = ReturnType<Awaited<ReturnType<typeof getOpenWorkflowRuntime>>["client"]["newWorker"]>

export interface CreateOpenWorkflowWorkerOptions {
  concurrency?: number
  config?: false | ResolvedWorkflowOptions
  registry?: WorkflowDefinitionRegistry
}

export interface StartOpenWorkflowWorkerOptions extends CreateOpenWorkflowWorkerOptions {
  signal?: AbortSignal
  signals?: boolean
}

function getProcess(): {
  off?: (event: string, listener: () => void) => void
  on?: (event: string, listener: () => void) => void
} | undefined {
  return (globalThis as { process?: { off?: (event: string, listener: () => void) => void, on?: (event: string, listener: () => void) => void } }).process
}

async function loadRegistryDefinitions(registry: WorkflowDefinitionRegistry) {
  const definitions = new Map<string, WorkflowDefinition>()
  for (const name of Object.keys(registry).sort()) {
    const loaded = await registry[name]?.()
    const definition = loaded && typeof loaded === "object" && "default" in loaded
      ? loaded.default
      : loaded
    if (definition && typeof definition === "object" && "handler" in definition && typeof definition.handler === "function") {
      definitions.set(name, definition)
    }
  }
  return definitions
}

function mergeInlineDefinitions(definitions: Map<string, WorkflowDefinition>) {
  for (const [name, definition] of getInlineWorkflowDefinitions()) {
    const existing = definitions.get(name)
    if (existing && existing !== definition) {
      throw new Error(`Duplicate workflow name "${name}" from inline and discovered definitions.`)
    }
    definitions.set(name, definition)
  }
}

export async function createOpenWorkflowWorker(options: CreateOpenWorkflowWorkerOptions = {}): Promise<OpenWorkflowWorker> {
  const config = options.config ?? getWorkflowRuntimeConfig()
  if (!config || config.provider !== "openworkflow") {
    throw new Error("OpenWorkflow worker requires workflow.provider \"openworkflow\".")
  }

  const registry = options.registry ?? getWorkflowRuntimeRegistry() ?? {}

  setWorkflowRuntimeConfig(config)
  setWorkflowRuntimeRegistry(registry)

  const runtime = await getOpenWorkflowRuntime(config)
  const definitions = await loadRegistryDefinitions(registry)
  mergeInlineDefinitions(definitions)
  for (const [name, definition] of definitions) {
    await registerOpenWorkflowDefinition(runtime, name, definition)
  }

  return runtime.client.newWorker({
    concurrency: options.concurrency ?? config.worker?.concurrency,
  })
}

export async function startOpenWorkflowWorker(options: StartOpenWorkflowWorkerOptions = {}): Promise<OpenWorkflowWorker> {
  const worker = await createOpenWorkflowWorker(options)
  await worker.start()

  const stop = () => {
    void worker.stop()
  }

  options.signal?.addEventListener("abort", stop, { once: true })
  const proc = getProcess()
  if (options.signals !== false) {
    proc?.on?.("SIGINT", stop)
    proc?.on?.("SIGTERM", stop)
  }

  return worker
}
