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
import { cancelOpenWorkflowRun, getOpenWorkflowRun, runOpenWorkflow } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { emitWorkflowFailed } from "./run-failed.ts"
import { toWorkflowRunError } from "./run-error.ts"
import { getInlineWorkflowDefinitions, getWorkflowRunState, getWorkflowRuntimeRegistry, loadWorkflowDefinition, setWorkflowRun } from "./state.ts"
import { cancelVercelWorkflow, inspectVercelWorkflowRun, resumeVercelWorkflowSignal, startVercelWorkflow } from "./vercel.ts"

import type { CloudflareWorkflowBinding, CloudflareWorkflowInstance, ResolvedWorkflowOptions, WorkflowDefinition, WorkflowRun, WorkflowRunStatus, WorkflowSignalResult, WorkflowStartOptions } from "../types.ts"
import type { WorkflowOperationName } from "../errors.ts"

interface RunWorkflowAdapterContext<TPayload = unknown, TResult = unknown> {
  definition: WorkflowDefinition<TPayload, TResult>
  event: unknown
  id: string
  name: string
  options: WorkflowStartOptions
  payload: TPayload | undefined
  startAt?: number
}

interface GetWorkflowAdapterContext {
  event: unknown
  id: string
  name: string
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

function isDevelopmentServer(): boolean {
  if (getWorkflowDevRecorder()) return true
  const mode = globalThis.process?.env?.NODE_ENV
  return mode === "development" || mode === "test"
}

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

function isCloudflareInstanceId(id: string): boolean {
  return cloudflareInstanceIdPattern.test(id)
}

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

function cloudflareRunResult(metadata: unknown): unknown {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "output")) return undefined
  // SAFETY: The guards establish a non-null object with an own output property, whose value remains unknown.
  const output = (metadata as { output?: unknown }).output
  return isSerializedResponse(output) ? deserializeResponse(output) : output
}

function ownStatusError(metadata: unknown): unknown {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "error")) return undefined
  return Reflect.get(metadata, "error")
}

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

async function cancelCloudflareRun(binding: CloudflareWorkflowBinding, id: string): Promise<WorkflowRun<unknown, unknown>> {
  const { instance, run } = await readCloudflareRun(binding, id)
  if (!instance || run.status === "unknown" || finishedRunStatuses.has(run.status)) return run
  try {
    await runWorkflowProviderOperation("cloudflare", "cancel", () => instance.terminate())
  }
  catch (error) {
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
      return binding ? await cancelCloudflareRun(binding, id) : await inlineAdapter(config).cancel({ event, id, name })
    },
    async get({ event, id, name }) {
      const binding = resolveCloudflareInspectionBinding(event, config.binding, name)
      if (binding) return (await readCloudflareRun(binding, id)).run
      return await inlineAdapter(config).get({ event, id, name })
    },
    async run<TPayload = unknown, TResult = unknown>(context: RunWorkflowAdapterContext<TPayload, TResult>): Promise<WorkflowRun<TPayload, TResult>> {
      const { definition, event, id, name, payload, startAt } = context
      if (!isCloudflareInstanceId(id)) throw workflowErrorDiagnostics.WORKFLOW_CLOUDFLARE_RUN_ID_INVALID({ id })
      const binding = resolveCloudflareBinding(event, config.binding, name, definition)
      if (binding) {
        resolveDispatchObserver(event)?.()
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
    resume: () => unsupportedOperation("cloudflare", "signals"),
  }
  return adapter
}

const warnedInlineOpenWorkflowNames = new Set<string>()

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
    resume: () => unsupportedOperation("openworkflow", "signals"),
    run: async (context) => {
      const { definition, event, name, options, payload, startAt } = context
      if (isDurableOpenWorkflowDefinition(name)) return await runOpenWorkflow(config, name, payload, definition, options, resolveDispatchObserver(event), startAt)
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

const maximumTimerDelay = 2_147_483_647

async function waitUntilTime(startAt: number | undefined): Promise<void> {
  while (startAt !== undefined && startAt > Date.now()) {
    await new Promise(resolve => setTimeout(resolve, Math.min(startAt - Date.now(), maximumTimerDelay)))
  }
}

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
      const recordRun = getWorkflowDevRecorder()?.start(name, id, config.driver)
      const execute = () => runSerializedWorkflowHandler({
        id,
        name,
        payload,
        provider: config.driver,
      // SAFETY: Workflow provider normalization establishes the asserted run contract.
      }, definition as never)
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
    resume: () => unsupportedOperation(config.driver, "signals"),
  }
}

function runsNatively<TPayload, TResult>(definition: WorkflowDefinition<TPayload, TResult> | undefined): definition is WorkflowDefinition<TPayload, TResult> {
  return Boolean(definition?.native) && !getWorkflowDevRecorder()
}

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
      if (getWorkflowDevRecorder()) unsupportedOperation(config.driver, "signals")
      try {
        return await resumeVercelWorkflowSignal(token, payload)
      }
      catch (error) {
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
