import { getViteHubErrorShape } from "@vite-hub/runtime"
import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime/internal/response"
import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { createWorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { toCloudflareStartParams } from "./delay.ts"
import { getWorkflowDevRecorder } from "./dev-recorder.ts"
import { runSerializedWorkflowHandler } from "./execute.ts"
import { cloudflareSignalEventType } from "./cloudflare-runner.ts"
import { cancelOpenWorkflowRun, getOpenWorkflowRun, resumeOpenWorkflowSignal, runOpenWorkflow } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { emitWorkflowFailed } from "./run-failed.ts"
import { toWorkflowRunError } from "./run-error.ts"
import { readWorkflowSignalToken, resumeInlineWorkflowSignal } from "./signals.ts"
import { getInlineWorkflowDefinitions, getWorkflowRunState, getWorkflowRuntimeEvent, getWorkflowRuntimeRegistry, loadWorkflowDefinition, setWorkflowRun } from "./state.ts"
import { cancelVercelWorkflow, inspectVercelWorkflowRun, resumeVercelWorkflowSignal, startVercelWorkflow } from "./vercel.ts"

import type { CloudflareWorkflowBinding, CloudflareWorkflowInstance, ResolvedWorkflowOptions, WorkflowDefinition, WorkflowRun, WorkflowRunStatus, WorkflowSignalResult, WorkflowStartOptions } from "../types.ts"
import type { WorkflowOperationName } from "../errors.ts"
import type { WorkflowSignalAddress } from "./signals.ts"

interface RunWorkflowAdapterContext<TPayload = unknown, TResult = unknown> {
  definition: WorkflowDefinition<TPayload, TResult>
  event: unknown
  id: string
  name: string
  options: WorkflowStartOptions
  payload: TPayload | undefined
  /** The time in milliseconds when a delayed run starts. Undefined starts the run now. */
  startAt?: number
}

interface GetWorkflowAdapterContext {
  event: unknown
  id: string
  name: string
}

/**
 * Resumes a run that waits on `context.createSignal()`. An inline run waits in this process. A durable run waits in
 * the provider of the token, which must be the provider of this app.
 */
async function resumeViteHubSignal<TPayload>(
  config: ResolvedWorkflowOptions,
  token: string,
  payload: TPayload,
  durable?: (address: WorkflowSignalAddress) => Promise<void>,
): Promise<WorkflowSignalResult> {
  const address = readWorkflowSignalToken(token)
  if (!address) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_TOKEN_INVALID({ provider: config.driver })
  if (address.host === "inline") resumeInlineWorkflowSignal(token, address, payload)
  else if (address.host === config.driver && durable) await durable(address)
  else throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_TOKEN_INVALID({ provider: config.driver })
  return { id: address.run, provider: config.driver }
}

interface WorkflowRuntimeAdapter {
  cancel(context: GetWorkflowAdapterContext): Promise<WorkflowRun<unknown, unknown>>
  get(context: GetWorkflowAdapterContext): Promise<WorkflowRun<unknown, unknown>>
  resume<TPayload = unknown>(token: string, payload: TPayload): Promise<WorkflowSignalResult>
  run<TPayload = unknown, TResult = unknown>(context: RunWorkflowAdapterContext<TPayload, TResult>): Promise<WorkflowRun<TPayload, TResult>>
}

function resolveDispatchObserver(event: unknown): (() => void) | undefined {
  if (!event || typeof event !== "object") return undefined
  const candidate = Object.hasOwn(event, "onDispatch")
    ? Reflect.get(event, "onDispatch")
    : undefined
  // SAFETY: The runtime event member is callable and takes no provider data.
  return typeof candidate === "function" ? candidate as () => void : undefined
}

function resolveSettlementObserver(event: unknown): ((promise: PromiseLike<unknown>) => void) | undefined {
  if (!event || typeof event !== "object") return undefined
  const candidate = Object.hasOwn(event, "settled")
    ? Reflect.get(event, "settled")
    : undefined
  // SAFETY: The typeof check establishes that the runtime event member is callable.
  if (typeof candidate === "function") return candidate as (promise: PromiseLike<unknown>) => void
  const context = Object.hasOwn(event, "context")
    ? Reflect.get(event, "context")
    : undefined
  if (!context || typeof context !== "object") return undefined
  const contextObject = Object(context)
  const nested = Object.hasOwn(contextObject, "settled")
    ? Reflect.get(contextObject, "settled")
    : undefined
  // SAFETY: The typeof check establishes that the nested runtime event member is callable.
  return typeof nested === "function" ? nested as (promise: PromiseLike<unknown>) => void : undefined
}

function unsupportedOperation(provider: "cloudflare" | "openworkflow" | "vercel", operation: WorkflowOperationName): never {
  throw createWorkflowError({
    code: "WORKFLOW_OPERATION_UNSUPPORTED",
    details: { operation, provider },
  })
}

/**
 * True on a development server: `vite dev` installs the run history. Code that ViteHub did not start, such as a test
 * runner, has no history, so `NODE_ENV` decides there.
 */
function isDevelopmentServer(): boolean {
  if (getWorkflowDevRecorder()) return true
  const mode = globalThis.process?.env?.NODE_ENV
  return mode === "development" || mode === "test"
}

/**
 * The Cloudflare Workflow binding of `name`. Only a development server runs the Workflow inline without it. Elsewhere,
 * a missing binding fails, because an inline run is not durable.
 */
function resolveCloudflareBinding(event: unknown, binding: string | undefined, name: string, definition?: { internalAgentInvocationRecovery?: true }) {
  const env = getCloudflareEnv(event)
  const bindingName = definition?.internalAgentInvocationRecovery
    ? getCloudflareWorkflowBindingName(name)
    : binding || getCloudflareWorkflowBindingName(name)
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  if (env && Object.hasOwn(env, bindingName)) return env[bindingName] as CloudflareWorkflowBinding
  if (isDevelopmentServer()) return undefined
  throw workflowErrorDiagnostics.WORKFLOW_R0036({ binding: bindingName, name })
}

function resolveCloudflareInspectionBinding(event: unknown, binding: string | undefined, name: string) {
  return resolveCloudflareBinding(event, binding, name, getWorkflowRuntimeRegistry()?.[name])
}

/** The start can have reached Cloudflare, so the acknowledgement is unknown. */
function invalidCloudflareWorkflowStart(cause?: unknown) {
  return createWorkflowError({
    ...(cause === undefined ? {} : { cause }),
    code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
    details: { acknowledgement: "unknown", operation: "create", provider: "cloudflare", reason: "Cloudflare Workflow provider returned an invalid workflow instance." },
  })
}

function normalizeCloudflareWorkflowStart(value: unknown, expectedId: string): { id: string } {
  if (typeof value !== "object" || value === null) throw invalidCloudflareWorkflowStart()

  let id: unknown
  try {
    id = Reflect.get(value, "id")
  }
  catch (cause) {
    throw invalidCloudflareWorkflowStart(cause)
  }

  if (typeof id !== "string" || !id || id !== expectedId) throw invalidCloudflareWorkflowStart()

  return { id }
}

const cloudflareInstanceIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/

/** The array-form `createBatch` accepts reserved ids, unlike the object form. */
function isCloudflareInstanceId(id: string): boolean {
  return cloudflareInstanceIdPattern.test(id)
}

// Cloudflare `waiting` (a sleep, an event wait, or a retry delay), `waitingForPause`, and `paused` are not finished, so
// they report `running` like a sleeping OpenWorkflow or Vercel run. `terminated` is a user cancellation.
const cloudflareStatusMap: Record<string, WorkflowRunStatus> = {
  cancelled: "cancelled",
  complete: "completed",
  completed: "completed",
  errored: "failed",
  failed: "failed",
  paused: "running",
  queued: "queued",
  running: "running",
  success: "completed",
  terminated: "cancelled",
  waiting: "running",
  waitingforpause: "running",
}

function normalizeCloudflareStatus(status: unknown): WorkflowRunStatus {
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  const value = typeof status === "object" && status && Object.hasOwn(status, "status")
    ? (status as { status?: unknown }).status
    : status
  const normalized = String(value || "").toLowerCase()
  return Object.hasOwn(cloudflareStatusMap, normalized) ? cloudflareStatusMap[normalized]! : "unknown"
}

/** The run result from Cloudflare status: the stored value, or a `Response` when the handler returned one. */
function cloudflareRunResult(metadata: unknown): unknown {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "output")) return undefined
  // SAFETY: The guards establish a non-null object with an own output property, whose value remains unknown.
  const output = (metadata as { output?: unknown }).output
  return isSerializedResponse(output) ? deserializeResponse(output) : output
}

/** The `error` member of a Cloudflare `status()` record. */
function ownStatusError(metadata: unknown): unknown {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "error")) return undefined
  return Reflect.get(metadata, "error")
}

/** Cloudflare `get(id)` rejects with `instance.not_found` when no instance has the id. */
function isCloudflareInstanceNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  try {
    const message: unknown = Reflect.get(error, "message")
    return typeof message === "string" && message.includes("instance.not_found")
  }
  catch {
    return false
  }
}

/**
 * The Cloudflare Workflows service refused the call: its error carries a service code such as `(instance.already_exists)`,
 * or local Miniflare rejected the instance id. A lost connection has neither.
 */
function isCloudflareRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  try {
    const message: unknown = Reflect.get(error, "message")
    return typeof message === "string" && /\((?:instance|workflow)\.[a-z_]+\)|^Workflow instance has invalid id/.test(message)
  }
  catch {
    return false
  }
}

function hasUnknownWorkflowAcknowledgement(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  const details = (error as { details?: unknown }).details
  return Boolean(details && typeof details === "object"
    // SAFETY: Workflow provider normalization establishes the asserted run contract.
    && (details as { acknowledgement?: unknown }).acknowledgement === "unknown")
}

/** Reads a Cloudflare Workflow instance and its run. A missing instance has no `instance` and reports `unknown`. */
async function readCloudflareRun(binding: CloudflareWorkflowBinding, id: string): Promise<{ instance?: CloudflareWorkflowInstance, run: WorkflowRun<unknown, unknown> }> {
  const instance = await runWorkflowProviderOperation("cloudflare", "get", async () => {
    try {
      return await binding.get(id)
    }
    catch (error) {
      if (isCloudflareInstanceNotFound(error)) return undefined
      throw error
    }
  })
  if (!instance) return { run: { id, provider: "cloudflare", status: "unknown" } }
  const metadata = await runWorkflowProviderOperation("cloudflare", "status", () => instance.status())
  const status = normalizeCloudflareStatus(metadata)
  return {
    instance,
    run: {
      ...(status === "failed" ? { error: toWorkflowRunError(ownStatusError(metadata)) } : {}),
      id,
      metadata,
      provider: "cloudflare",
      result: status === "completed" ? cloudflareRunResult(metadata) : undefined,
      status,
    },
  }
}

const finishedRunStatuses: ReadonlySet<WorkflowRunStatus> = new Set(["cancelled", "completed", "failed"])

/**
 * Terminates a Cloudflare Workflow instance that has not finished and returns its run afterwards. A finished run keeps
 * and reports its status, and a missing run reports `unknown`, as on OpenWorkflow.
 */
async function cancelCloudflareRun(binding: CloudflareWorkflowBinding, id: string): Promise<WorkflowRun<unknown, unknown>> {
  const { instance, run } = await readCloudflareRun(binding, id)
  if (!instance || run.status === "unknown" || finishedRunStatuses.has(run.status)) return run
  try {
    await runWorkflowProviderOperation("cloudflare", "cancel", () => instance.terminate())
  }
  catch (error) {
    // `terminate()` throws when the instance finishes between the read and the call.
    const latest = await readCloudflareRun(binding, id).catch(() => undefined)
    if (latest && finishedRunStatuses.has(latest.run.status)) return latest.run
    throw error
  }
  return (await readCloudflareRun(binding, id)).run
}

function createCloudflareAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  const adapter: WorkflowRuntimeAdapter = {
    async cancel({ event, id, name }) {
      const binding = resolveCloudflareInspectionBinding(event, config.binding, name)
      // Without a binding, `vite dev` runs the Workflow inline, and an inline run cannot be cancelled.
      return binding ? await cancelCloudflareRun(binding, id) : await inlineAdapter(config).cancel({ event, id, name })
    },
    async get({ event, id, name }) {
      const binding = resolveCloudflareInspectionBinding(event, config.binding, name)
      if (binding) return (await readCloudflareRun(binding, id)).run
      return await inlineAdapter(config).get({ event, id, name })
    },
    async run<TPayload = unknown, TResult = unknown>(context: RunWorkflowAdapterContext<TPayload, TResult>): Promise<WorkflowRun<TPayload, TResult>> {
      const { definition, event, id, name, payload, startAt } = context
      // Check in `vite dev` too, where the run can be inline, so the id fails before deployment.
      if (!isCloudflareInstanceId(id)) throw workflowErrorDiagnostics.WORKFLOW_CLOUDFLARE_RUN_ID_INVALID({ id })
      const binding = resolveCloudflareBinding(event, config.binding, name, definition)
      if (binding) {
        resolveDispatchObserver(event)?.()
        // `createBatch` skips an id that already has an instance and returns no instance for it.
        let created = false
        const start = () => runWorkflowProviderOperation(
          "cloudflare",
          "create",
          async () => {
            const [instance] = await binding.createBatch([{ id, params: toCloudflareStartParams(payload, startAt) }])
            created = instance !== undefined
            return normalizeCloudflareWorkflowStart(instance || await binding.get(id), id)
          },
          {
            acknowledgement: (error, status) => status === undefined
              ? isCloudflareRejection(error) ? "rejected" : "unknown"
              : status < 500 ? "rejected" : undefined,
          },
        )
        const instance = await start().catch(async (firstError) => {
          try {
            return await start()
          }
          catch (retryError) {
            if (hasUnknownWorkflowAcknowledgement(firstError)) throw firstError
            throw retryError
          }
        })
        // Cloudflare does not return the payload of an existing instance, so report its state without a payload.
        // SAFETY: The existing instance belongs to this Workflow Definition, so it has its payload and result types.
        if (!created) return await adapter.get({ event, id, name }) as WorkflowRun<TPayload, TResult>
        return {
          id: instance.id,
          payload,
          provider: "cloudflare",
          status: "queued",
        }
      }

      return await inlineAdapter(config).run(context)
    },
    resume: async (token, payload) => await resumeViteHubSignal(config, token, payload, async ({ run, signal, workflow }) => {
      const binding = resolveCloudflareInspectionBinding(getWorkflowRuntimeEvent(), config.binding, workflow)
      if (!binding) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_NOT_WAITING({ run })
      const { instance, run: current } = await readCloudflareRun(binding, run)
      if (!instance || finishedRunStatuses.has(current.status)) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_NOT_WAITING({ run })
      await runWorkflowProviderOperation("cloudflare", "resume-signal", async () => {
        if (!instance.sendEvent) unsupportedOperation("cloudflare", "signals")
        try {
          await instance.sendEvent({ payload, type: cloudflareSignalEventType(signal) })
        }
        catch (error) {
          if (isCloudflareInstanceNotFound(error)) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_NOT_WAITING({ run })
          throw error
        }
      })
    }),
  }
  return adapter
}

const warnedInlineOpenWorkflowNames = new Set<string>()

/**
 * Every OpenWorkflow worker registers the Workflow Definitions of the build registry when it starts: discovered
 * Workflows and discovered Agent Workflows. Any worker can claim a run, so a run of an inline
 * `createWorkflow(name, handler)` could wait in storage on a worker that never registers it. Those runs execute inline
 * in this process. A turn of an Agent that is not discovered fails with `WORKFLOW_AGENT_NOT_DISCOVERED`, so Agent turns are
 * never inline.
 */
function isDurableOpenWorkflowDefinition(name: string): boolean {
  const registry = getWorkflowRuntimeRegistry()
  return Boolean(registry && Object.hasOwn(registry, name))
}

function createOpenWorkflowAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  const inline = inlineAdapter(config)
  return {
    cancel: async ({ event, id, name }) => isDurableOpenWorkflowDefinition(name)
      ? await cancelOpenWorkflowRun(config, name, id)
      : await inline.cancel({ event, id, name }),
    get: async ({ event, id, name }) => isDurableOpenWorkflowDefinition(name)
      ? await getOpenWorkflowRun(config, name, id)
      : await inline.get({ event, id, name }),
    resume: async (token, payload) => await resumeViteHubSignal(config, token, payload, async ({ run, workflow }) => {
      if (!await resumeOpenWorkflowSignal(config, workflow, run, token, payload)) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_NOT_WAITING({ run })
    }),
    run: async (context) => {
      const { definition, event, name, options, payload, startAt } = context
      if (isDurableOpenWorkflowDefinition(name)) return await runOpenWorkflow(config, name, payload, definition, options, resolveDispatchObserver(event), startAt)
      // An Agent turn must be durable. The registry has every discovered Agent, so this one is not discovered.
      if (definition?.internalAgentWorkflow || definition?.internalAgentInvocationRecovery) throw workflowErrorDiagnostics.WORKFLOW_AGENT_NOT_DISCOVERED({ name })
      if (!warnedInlineOpenWorkflowNames.has(name)) {
        warnedInlineOpenWorkflowNames.add(name)
        console.warn(`[vitehub:workflow] The Workflow ${JSON.stringify(name)} is not a discovered file, so OpenWorkflow workers cannot run it. Its runs execute inline in this process and are not durable. Move it to server/workflows/ to make it durable.`)
      }
      const run = await inline.run(context)
      return { ...run, metadata: { mode: "inline", workflow: name } }
    },
  }
}

/** `setTimeout` fires at once for a delay above 2^31 - 1 ms (about 24.8 days), so a long wait uses several timers. */
const maximumTimerDelay = 2_147_483_647

async function waitUntilTime(startAt: number | undefined): Promise<void> {
  while (startAt !== undefined && startAt > Date.now()) {
    await new Promise(resolve => setTimeout(resolve, Math.min(startAt - Date.now(), maximumTimerDelay)))
  }
}

/** The inline run state forgets a finished run after five minutes. `vite dev` keeps its run history longer. */
function recordedDevRun(config: ResolvedWorkflowOptions, name: string, id: string): WorkflowRun<unknown, unknown> | undefined {
  const record = getWorkflowDevRecorder()?.get(name, id)
  if (record?.status !== "completed" && record?.status !== "failed") return
  return {
    ...(record.status === "failed" ? { error: toWorkflowRunError(record.error) } : {}),
    id,
    provider: config.driver,
    result: isSerializedResponse(record.result) ? deserializeResponse(record.result) : record.result,
    status: record.status,
  }
}

function inlineAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: () => unsupportedOperation(config.driver, "cancellation"),
    async get({ id, name }: GetWorkflowAdapterContext): Promise<WorkflowRun<unknown, unknown>> {
      const run = getWorkflowRunState(name, id)
      if (run) {
        if (run.status === "running") {
          return {
            id,
            provider: config.driver,
            status: run.startAt === undefined ? "running" : "queued",
          }
        }
        return {
          ...(run.status === "failed" ? { error: toWorkflowRunError(run.error) } : {}),
          id,
          provider: config.driver,
          result: isSerializedResponse(run.result) ? deserializeResponse(run.result) : run.result,
          status: run.status,
        }
      }
      const recorded = recordedDevRun(config, name, id)
      if (recorded) return recorded
      return {
        id,
        provider: config.driver,
        status: "unknown",
      }
    },
    async run<TPayload = unknown, TResult = unknown>({ definition, event, id, name, payload, startAt }: RunWorkflowAdapterContext<TPayload, TResult>) {
      const existing = getWorkflowRunState(name, id)
      // A second start with the id of a run that the dev history still has returns that run, as `get` reports it.
      const recorded = existing ? undefined : recordedDevRun(config, name, id)
      if (recorded) {
        // SAFETY: The recorded run belongs to this Workflow Definition, so it has its payload and result types.
        return {
          ...recorded,
          metadata: config.driver === "vercel" ? { mode: "inline", workflow: getVercelWorkflowName(name) } : undefined,
        } as WorkflowRun<TPayload, TResult>
      }
      if (existing) {
        return {
          ...(existing.status === "failed" ? { error: toWorkflowRunError(existing.error) } : {}),
          id,
          metadata: config.driver === "vercel" ? { mode: "inline", workflow: getVercelWorkflowName(name) } : undefined,
          payload: existing.payload as TPayload | undefined,
          provider: config.driver,
          result: (isSerializedResponse(existing.result) ? deserializeResponse(existing.result) : existing.result) as TResult | undefined,
          status: existing.status === "running" ? "queued" : existing.status,
        }
      }
      resolveDispatchObserver(event)?.()
      // Only `vite dev` has a recorder. It records the run in the dev history.
      const recordRun = getWorkflowDevRecorder()?.start(name, id, config.driver)
      const execute = () => runSerializedWorkflowHandler({
        id,
        name,
        payload,
        provider: config.driver,
      // SAFETY: Workflow provider normalization establishes the asserted run contract.
      }, definition as never)
      // A timer holds a delayed run in this process. It is not durable: a restart loses the run.
      const run = waitUntilTime(startAt)
        .then(() => {
          runState.startAt = undefined
          return recordRun ? recordRun(execute) : execute()
        })
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        .then(result => ({ result, status: "completed" as const }))
        .catch((error: unknown) => ({ error, status: "failed" as const }))
      const runState = setWorkflowRun(name, id, run, payload, true)
      runState.startAt = startAt
      const notify = runState.promise.then(async (outcome) => {
        if (outcome.status === "failed") await emitWorkflowFailed(name, id, outcome.error, definition)
      })
      resolveWaitUntil(event)?.(notify)

      return {
        id,
        metadata: config.driver === "vercel" ? { mode: "inline", workflow: getVercelWorkflowName(name) } : undefined,
        payload,
        provider: config.driver,
        status: "queued",
      }
    },
    resume: async (token, payload) => await resumeViteHubSignal(config, token, payload),
  }
}

/**
 * True when Workflow DevKit runs the `native` entry. `vite dev` does not run the Workflow DevKit transform, so the
 * dev server runs the normal handler inline, as for every other Workflow there.
 */
function runsNatively<TPayload, TResult>(definition: WorkflowDefinition<TPayload, TResult> | undefined): definition is WorkflowDefinition<TPayload, TResult> {
  return Boolean(definition?.native) && !getWorkflowDevRecorder()
}

/** Whether a registered Workflow has a native Vercel entry, so a run of it can wait for a signal. */
async function hasNativeWorkflowDefinition(): Promise<boolean> {
  const names = new Set([...Object.keys(getWorkflowRuntimeRegistry() ?? {}), ...getInlineWorkflowDefinitions().keys()])
  for (const name of names) {
    if ((await loadWorkflowDefinition(name))?.native) return true
  }
  return false
}

function createVercelAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  const fallback = inlineAdapter(config)
  return {
    async cancel({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      if (!runsNatively(definition)) {
        return await fallback.cancel({ event: undefined, id, name })
      }
      return await cancelVercelWorkflow(name, definition, id)
    },
    async get({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      return runsNatively(definition)
        ? await inspectVercelWorkflowRun(name, definition, id)
        : await fallback.get({ event: undefined, id, name })
    },
    async resume(token, payload) {
      // `context.createSignal()` throws on Vercel, so a ViteHub token comes from another app or provider.
      if (readWorkflowSignalToken(token)) throw workflowErrorDiagnostics.WORKFLOW_SIGNAL_TOKEN_INVALID({ provider: config.driver })
      // `vite dev` runs every Workflow inline, and an inline run never waits for a hook.
      if (getWorkflowDevRecorder()) unsupportedOperation(config.driver, "signals")
      try {
        return await resumeVercelWorkflowSignal(token, payload)
      }
      catch (error) {
        // Without the Workflow DevKit, an app with no native entry runs only inline. Installing the SDK does not help.
        if (getViteHubErrorShape(error)?.code === "VERCEL_WORKFLOW_SDK_LOAD_FAILED" && !await hasNativeWorkflowDefinition()) {
          unsupportedOperation(config.driver, "signals")
        }
        throw error
      }
    },
    async run(context) {
      const { definition, event, name, payload, startAt } = context
      if (!runsNatively(definition)) {
        return await fallback.run(context)
      }
      return await startVercelWorkflow(name, definition, payload, resolveSettlementObserver(event), resolveDispatchObserver(event), startAt)
    },
  }
}

export function getWorkflowRuntimeAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  if (config.driver === "cloudflare") {
    return createCloudflareAdapter(config)
  }
  if (config.driver === "openworkflow") {
    return createOpenWorkflowAdapter(config)
  }
  return createVercelAdapter(config)
}
