import { onShutdown } from "@vite-hub/runtime/shutdown"

import { getOpenWorkflowRuntime, registerOpenWorkflowDefinition, resetOpenWorkflowRuntime, setOpenWorkflowImporter, watchOpenWorkflowDefinitions } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry, takeInlineWorkflowDefinitionForModule } from "./state.ts"
import { hasRuntimeType, isRuntimeRecord } from "../internal/runtime-type.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { createWorkflowError } from "../errors.ts"

import type { ShutdownApp } from "@vite-hub/runtime/shutdown"
import type { ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDefinitionRegistry } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

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
  return isRuntimeRecord(value)
    && Object.hasOwn(value, "handler")
    && hasRuntimeType(value.handler, "function")
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
      throw workflowErrorDiagnostics.WORKFLOW_R0016({ message: `Duplicate workflow name "${name}" from inline and discovered definitions.` })
    }
    definitions.set(name, definition)
  }
}

/** Registers every Workflow Definition of the registry on the OpenWorkflow client, before a worker copies them. */
async function prepareOpenWorkflowWorker(options: CreateOpenWorkflowWorkerOptions) {
  const config = options.config ?? getWorkflowRuntimeConfig()
  if (!config || config.provider !== "openworkflow") {
    throw workflowErrorDiagnostics.WORKFLOW_R0017({ message: "OpenWorkflow worker requires workflow.provider \"openworkflow\"." })
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

  return {
    concurrency: options.concurrency ?? (config.worker ? config.worker.concurrency : undefined),
    runtime,
  }
}

export async function createOpenWorkflowWorker(options: CreateOpenWorkflowWorkerOptions = {}): Promise<OpenWorkflowWorker> {
  const { concurrency, runtime } = await prepareOpenWorkflowWorker(options)
  return runtime.client.newWorker({ concurrency })
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

/** The part of a Nitro app that `installOpenWorkflow()` uses. */
export interface OpenWorkflowWorkerApp extends ShutdownApp {
  captureError?: (error: Error, context: { tags: string[] }) => void
}

// Literal specifiers let the server bundler include OpenWorkflow. `.output` has no `node_modules`, so the variable
// import of the default importer cannot load it there.
const bundledOpenWorkflowModules: Readonly<Record<string, () => Promise<unknown>>> = {
  "openworkflow": () => import("openworkflow"),
  "openworkflow/postgres": () => import("openworkflow/postgres"),
  "openworkflow/sqlite": () => import("openworkflow/sqlite"),
}

/**
 * Installs OpenWorkflow in a long-lived Nitro server. The generated Workflow startup plugin calls it after it installs
 * the runtime config and registry. It loads OpenWorkflow from the server bundle, then starts the worker unless
 * `workflow.worker` is `false`. The worker stops when the server stops.
 *
 * A worker copies the Workflow Definitions when it is created. When this process registers a new definition later,
 * such as an inline `createWorkflow()` or an Agent Workflow, a new worker replaces the current one. Several servers
 * can run a worker on the same storage: OpenWorkflow claims each run with `FOR UPDATE SKIP LOCKED` on Postgres.
 */
interface ActiveOpenWorkflowInstall {
  /** Stops claiming runs and releases the hooks of this install. It does not wait for runs that are executing. */
  release(): Promise<void>
}

// `vite dev` runs the startup plugin again after a server file changes, in the same process. The install is kept on
// `globalThis` so the next install finds it even when the module is evaluated again.
const activeInstallKey = Symbol.for("vitehub.workflow.openworkflow.install")

function replaceActiveInstall(next: ActiveOpenWorkflowInstall): ActiveOpenWorkflowInstall | undefined {
  // SAFETY: Only this module writes the value at this registered symbol.
  const scope = globalThis as { [activeInstallKey]?: ActiveOpenWorkflowInstall }
  const previous = scope[activeInstallKey]
  scope[activeInstallKey] = next
  return previous
}

function useBundledOpenWorkflow(): void {
  setOpenWorkflowImporter(async (specifier) => {
    const load = bundledOpenWorkflowModules[specifier]
    // SAFETY: Each caller names the module type of the specifier that it imports.
    return await (load ? load() : import(/* @vite-ignore */ specifier)) as never
  })
}

/**
 * Installs OpenWorkflow in a long-lived Nitro server. The generated Workflow startup plugin calls it after it installs
 * the runtime config and registry. It loads OpenWorkflow from the server bundle, then starts the worker unless
 * `workflow.worker` is `false`. The worker stops when the server stops.
 *
 * A worker copies the Workflow Definitions when it is created. When this process registers a new definition later,
 * such as an inline `createWorkflow()` or an Agent Workflow, a new worker replaces the current one. When the plugin
 * runs again in the same process, as `vite dev` does after a file changes, the previous worker stops and the new one
 * uses the changed definitions. Several servers can run a worker on the same storage: OpenWorkflow claims each run
 * with `FOR UPDATE SKIP LOCKED` on Postgres.
 */
export function installOpenWorkflow(app: OpenWorkflowWorkerApp): void {
  const config = getWorkflowRuntimeConfig()
  if (!config || config.provider !== "openworkflow") return
  useBundledOpenWorkflow()

  const retired = new Set<Promise<void>>()
  let closed = false
  let unwatch: (() => void) | undefined
  let worker: OpenWorkflowWorker | undefined

  const report = (error: unknown): void => {
    const reported = error instanceof ViteHubError
      ? error
      : createWorkflowError({ cause: error, code: "OPENWORKFLOW_WORKER_FAILED", details: { provider: "openworkflow" } })
    try {
      console.error("[vitehub:workflow]", reported)
      app.captureError?.(reported, { tags: ["vitehub-workflow"] })
    }
    catch {}
  }

  // `stop()` stops claiming runs at once, then waits for the runs that the worker executes.
  const retire = (previous: OpenWorkflowWorker): void => {
    const task: Promise<void> = Promise.resolve()
      .then(() => previous.stop())
      .catch(report)
      .finally(() => retired.delete(task))
    retired.add(task)
  }

  let started: Promise<void> = Promise.resolve()
  const release = async (): Promise<void> => {
    closed = true
    await started
    unwatch?.()
    if (worker) retire(worker)
    worker = undefined
  }
  const previous = replaceActiveInstall({ release })

  started = (async () => {
    if (previous) {
      // The OpenWorkflow client keeps the definitions that it registered, so a fresh runtime takes the changed ones.
      await previous.release()
      await resetOpenWorkflowRuntime()
      useBundledOpenWorkflow()
    }
    if (closed || config.worker === false) return
    const { concurrency, runtime } = await prepareOpenWorkflowWorker({ config })
    if (closed) return
    const start = () => {
      const next = runtime.client.newWorker({ concurrency })
      if (worker) retire(worker)
      worker = next
      return Promise.resolve().then(() => next.start()).catch(report)
    }
    unwatch = watchOpenWorkflowDefinitions(runtime, () => {
      if (!closed) void start()
    })
    await start()
  })().catch(report)

  onShutdown(app, "workflow.openworkflow-worker", async ({ signal }) => {
    await release()
    // A run that does not finish before the drain budget ends keeps its lease. Another worker takes it when the
    // lease ends.
    await Promise.race([
      Promise.all(retired),
      new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
    ])
  })
}
