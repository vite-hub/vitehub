import { getOpenWorkflowRuntime, registerOpenWorkflowDefinition } from "./openworkflow.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinitionForModule } from "./state.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { createWorkflowError } from "../errors.ts"

import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"

type OpenWorkflowWorker = ReturnType<Awaited<ReturnType<typeof getOpenWorkflowRuntime>>["client"]["newWorker"]>

export interface CreateOpenWorkflowWorkerOptions {
  concurrency?: number
  config?: false | ResolvedWorkflowOptions
  registry?: WorkflowDefinitionRegistry
}

export interface StartOpenWorkflowWorkerOptions extends CreateOpenWorkflowWorkerOptions {
  onError?: (error: ViteHubError) => Promise<void> | void
  signal?: AbortSignal
  signals?: boolean
}

function getProcess(): {
  emitWarning?: (warning: Error) => void
  off?: (event: string, listener: () => void) => void
  on?: (event: string, listener: () => void) => void
} | undefined {
  return (globalThis as {
    process?: {
      emitWarning?: (warning: Error) => void
      off?: (event: string, listener: () => void) => void
      on?: (event: string, listener: () => void) => void
    }
  }).process
}

async function loadRegistryDefinitions(registry: WorkflowDefinitionRegistry) {
  const definitions = new Map<string, WorkflowDefinition>()
  for (const name of Object.keys(registry).sort()) {
    const loaded = await registry[name]?.()
    const definition = (loaded && typeof loaded === "object" && "default" in loaded
      ? loaded.default
      : loaded) as WorkflowDefinition | undefined
    if (definition && typeof definition === "object" && "handler" in definition && typeof definition.handler === "function") {
      definitions.set(name, definition)
      continue
    }
    const inlineDefinition = takeInlineWorkflowDefinitionForModule(name, loaded)
    if (inlineDefinition) {
      definitions.set(name, inlineDefinition)
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

  const originalStop = worker.stop.bind(worker)
  const proc = getProcess()
  let abortListenerActive = false
  let processListenersActive = false
  let stopTask: Promise<void> | undefined

  const removeListeners = () => {
    if (abortListenerActive) {
      abortListenerActive = false
      options.signal?.removeEventListener("abort", requestStop)
    }
    if (processListenersActive) {
      processListenersActive = false
      proc?.off?.("SIGINT", requestStop)
      proc?.off?.("SIGTERM", requestStop)
    }
  }

  const stop = (): Promise<void> => {
    removeListeners()
    stopTask ??= Promise.resolve()
      .then(() => originalStop())
      .catch((cause) => {
        throw createWorkflowError({
          cause,
          code: "OPENWORKFLOW_WORKER_STOP_FAILED",
          details: { provider: "openworkflow" },
        })
      })
    return stopTask
  }

  const reportUnhandledError = (error: ViteHubError): void => {
    try {
      if (proc?.emitWarning) proc.emitWarning(error)
      else console.error(error)
    }
    catch {}
  }

  const reportError = (error: ViteHubError): void => {
    if (!options.onError) {
      reportUnhandledError(error)
      return
    }
    try {
      Promise.resolve(options.onError(error)).catch(() => {
        reportUnhandledError(error)
      })
    }
    catch {
      reportUnhandledError(error)
    }
  }

  function requestStop(): void {
    stop().catch(reportError)
  }

  Object.defineProperty(worker, "stop", {
    configurable: true,
    value: stop,
    writable: true,
  })

  if (options.signal) {
    abortListenerActive = true
    options.signal.addEventListener("abort", requestStop, { once: true })
  }
  if (options.signals !== false && proc?.on && proc.off) {
    processListenersActive = true
    proc.on("SIGINT", requestStop)
    proc.on("SIGTERM", requestStop)
  }
  if (options.signal?.aborted) requestStop()

  return worker
}
