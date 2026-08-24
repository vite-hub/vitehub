import { getOpenWorkflowRuntime, registerOpenWorkflowDefinition } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinitionForModule } from "./state.ts"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
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
  return globalThis.process
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return isRuntimeRecord(value) && hasRuntimeType(value.handler, "function")
}

async function loadRegistryDefinitions(registry: WorkflowDefinitionRegistry) {
  const definitions = new Map<string, WorkflowDefinition>()
  for (const name of Object.keys(registry).sort()) {
    const loaded = await registry[name]?.()
    const definition = (isRuntimeRecord(loaded) && "default" in loaded
      ? loaded.default
      : loaded)
    if (isWorkflowDefinition(definition)) {
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
  await runWorkflowProviderOperation("openworkflow", "start", async () => {
    let removeStartupAbortListener: (() => void) | undefined
    let startTask: Promise<void> | undefined
    try {
      if (options.signal?.aborted) throw options.signal.reason
      startTask = Promise.resolve(worker.start())
      if (!options.signal) {
        await startTask
      }
      else {
        const signal = options.signal
        const abortTask = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason)
          removeStartupAbortListener = () => signal.removeEventListener("abort", abort)
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        })
        await Promise.race([startTask, abortTask])
      }
    }
    catch (startError) {
      const stopTask = Promise.resolve().then(() => worker.stop())
      if (startTask && options.signal?.aborted) {
        void startTask.then(async () => {
          await stopTask.catch(() => {})
          await worker.stop()
        }).catch(() => {})
      }
      try {
        await stopTask
      }
      catch (stopError) {
        throw new AggregateError(
          [startError, stopError],
          "OpenWorkflow worker startup and cleanup failed.",
        )
      }
      throw startError
    }
    finally {
      removeStartupAbortListener?.()
    }
  }, {
    boundaryError: error => options.signal?.aborted === true && error === options.signal.reason,
  })

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
