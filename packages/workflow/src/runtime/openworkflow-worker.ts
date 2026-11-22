import { onShutdown } from "@vite-hub/runtime/internal/shutdown"

import { describeOpenWorkflowStorage, detachOpenWorkflowRuntimes, getOpenWorkflowRuntime, registerOpenWorkflowDefinition, setOpenWorkflowDatabaseUrl, setOpenWorkflowImporter } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry, loadWorkflowDefinition, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "./state.ts"
import { ViteHubError } from "@vite-hub/runtime"
import { createWorkflowError } from "../errors.ts"

import type { ShutdownApp } from "@vite-hub/runtime/internal/shutdown"
import type { ResolvedWorkflowOptions, WorkflowDefinitionRegistry } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { defaultOpenWorkflowWorkerConcurrency } from "../internal/openworkflow-defaults.ts"

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

async function prepareOpenWorkflowWorker(options: CreateOpenWorkflowWorkerOptions) {
  const config = options.config ?? getWorkflowRuntimeConfig()
  if (!config || config.driver !== "openworkflow") {
    throw workflowErrorDiagnostics.WORKFLOW_R0017({ message: "OpenWorkflow worker requires workflow.driver \"openworkflow\"." })
  }

  const registry = options.registry ?? getWorkflowRuntimeRegistry() ?? {}

  setWorkflowRuntimeConfig(config)
  if (registry !== getWorkflowRuntimeRegistry()) setWorkflowRuntimeRegistry(registry)

  const runtime = await getOpenWorkflowRuntime(config)
  for (const name of Object.keys(registry).sort()) {
    const definition = await loadWorkflowDefinition(name)
    if (definition && Object.hasOwn(definition, "handler")) await registerOpenWorkflowDefinition(runtime, name, definition)
  }

  return {
    concurrency: options.concurrency ?? (config.worker ? config.worker.concurrency : undefined) ?? defaultOpenWorkflowWorkerConcurrency,
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

export interface InstallOpenWorkflowOptions {
  /**
   * Returns the connection URL of the Postgres Default Database. The generated plugin passes it when the build has
   * one, and OpenWorkflow then keeps its runs there unless its own storage is configured.
   */
  databaseUrl?: () => string | undefined
}

const bundledOpenWorkflowModules: Readonly<Record<string, () => Promise<unknown>>> = {
  "openworkflow": () => import("openworkflow"),
  "openworkflow/postgres": () => import("openworkflow/postgres"),
  "openworkflow/sqlite": () => import("openworkflow/sqlite"),
  "postgres": () => import("postgres"),
}

const openWorkflowStartDelayMs = 500
const permanentSetupErrorCodes = new Set(["WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING", "WORKFLOW_OPENWORKFLOW_DATABASE_URL_IGNORED"])

function hasPermanentSetupError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    const code: unknown = Reflect.get(current, "code")
    if (typeof code === "string" && permanentSetupErrorCodes.has(code)) return true
    current = Reflect.get(current, "cause")
  }
  return false
}
const openWorkflowStartMaxDelayMs = 30_000

interface ActiveOpenWorkflowInstall {
  detachRuntimes(): () => Promise<void>
  finished(): Promise<void>
  release(): Promise<void>
}

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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Installs OpenWorkflow in a long-lived Nitro server. The generated Workflow startup plugin calls it after it installs
 * the runtime config and registry. It loads OpenWorkflow from the server bundle, then starts the worker unless
 * `workflow.worker` is `false`. The worker stops when the server stops.
 *
 * The worker registers the discovered Workflow Definitions of the registry, which every server of the build has.
 * When the storage is not ready, setup runs again until it works, with a delay that grows to 30 seconds. Each failure
 * is reported. A failure that only a configuration change fixes, such as `WORKFLOW_OPENWORKFLOW_DATABASE_URL_MISSING`, stops the retries. The server keeps serving requests, and queued runs wait in storage until the worker starts.
 * The returned promise resolves to `true` when the worker runs, and to `false` when it is off or the server closed
 * first. When the plugin runs again in the same process, as `vite dev` does after a file changes, the previous worker
 * stops taking runs, finishes the runs that it executes on its own backend, and the new one uses the changed definitions.
 */
export function installOpenWorkflow(app: OpenWorkflowWorkerApp, options: InstallOpenWorkflowOptions = {}): Promise<boolean> {
  const config = getWorkflowRuntimeConfig()
  if (!config || config.driver !== "openworkflow") return Promise.resolve(false)
  useBundledOpenWorkflow()
  setOpenWorkflowDatabaseUrl(options.databaseUrl)

  const closing = new AbortController()
  let worker: OpenWorkflowWorker | undefined
  let stopped: Promise<void> = Promise.resolve()

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

  let started: Promise<boolean> = Promise.resolve(false)
  const release = async (): Promise<void> => {
    closing.abort()
    await started
    if (!worker) return
    const current = worker
    worker = undefined
    stopped = Promise.resolve().then(() => current.stop()).catch(report)
  }
  const finished = () => stopped
  const previous = replaceActiveInstall({ detachRuntimes: detachOpenWorkflowRuntimes, finished, release })

  started = (async () => {
    if (previous) {
      await previous.release()
      const closeRuntimes = previous.detachRuntimes()
      void previous.finished().then(closeRuntimes).catch(report)
    }
    if (Object.keys(getWorkflowRuntimeRegistry() ?? {}).length === 0) return false
    try {
      logDefaultStorage()
    }
    catch (error) {
      report(error)
    }
    if (closing.signal.aborted || config.worker === false) return false
    for (let attempt = 1; !closing.signal.aborted; attempt++) {
      try {
        const { concurrency, runtime } = await prepareOpenWorkflowWorker({ config })
        if (closing.signal.aborted) return false
        const next = runtime.client.newWorker({ concurrency })
        await next.start()
        worker = next
        return true
      }
      catch (error) {
        report(error)
        if (hasPermanentSetupError(error)) return false
        const wait = Math.min(openWorkflowStartDelayMs * 2 ** (attempt - 1), openWorkflowStartMaxDelayMs)
        console.warn(`[vitehub:workflow] The OpenWorkflow worker did not start (attempt ${attempt}). It tries again in ${wait} ms.`)
        await delay(wait, closing.signal)
      }
    }
    return false
  })()

  function logDefaultStorage(): void {
    if (!config || describeOpenWorkflowStorage(config).source !== "default") return
    console.warn("[vitehub:workflow] OpenWorkflow keeps runs in .vitehub/data/openworkflow.sqlite.db on this host. Other server instances do not see them. To share runs, add a Postgres Default Database, or set OPENWORKFLOW_POSTGRES_URL.")
  }

  onShutdown(app, "workflow.openworkflow-worker", async ({ signal }) => {
    await release()
    await Promise.race([
      finished(),
      new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
    ])
  })
  return started
}
