import { deserializeResponse, isSerializedResponse } from "@vite-hub/runtime"
import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
import { createWorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { getWorkflowDevRecorder } from "./dev-recorder.ts"
import { runSerializedWorkflowHandler } from "./execute.ts"
import { cancelOpenWorkflowRun, getOpenWorkflowRun, runOpenWorkflow } from "./openworkflow.ts"
import { runWorkflowProviderOperation } from "./provider-operation.ts"
import { getWorkflowRunState, getWorkflowRuntimeRegistry, loadWorkflowDefinition, setWorkflowRun } from "./state.ts"
import { cancelVercelWorkflow, inspectVercelWorkflowRun, resumeVercelWorkflowSignal, startVercelWorkflow } from "./vercel.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowDefinition, WorkflowRun, WorkflowRunStatus, WorkflowSignalResult, WorkflowStartOptions } from "../types.ts"
import type { WorkflowOperationName } from "../errors.ts"

interface RunWorkflowAdapterContext<TPayload = unknown, TResult = unknown> {
  definition: WorkflowDefinition<TPayload, TResult>
  event: unknown
  id: string
  name: string
  options: WorkflowStartOptions
  payload: TPayload | undefined
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

function normalizeCloudflareWorkflowStart(value: unknown, expectedId: string): { id: string } {
  if (typeof value !== "object" || value === null) {
    throw new Error("Cloudflare Workflow provider returned an invalid workflow instance.")
  }

  let id: unknown
  try {
    id = Reflect.get(value, "id")
  }
  catch (cause) {
    throw new Error("Cloudflare Workflow provider returned an invalid workflow instance.", { cause })
  }

  if (typeof id !== "string" || !id || id !== expectedId) {
    throw new Error("Cloudflare Workflow provider returned an invalid workflow instance.")
  }

  return { id }
}

const cloudflareInstanceIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/
const reservedCloudflareInstanceIds: ReadonlySet<string> = new Set(["batch", "terminate", "terminateAll"])

/** True when Cloudflare accepts `id` as a new Workflow instance id. */
function isCloudflareInstanceId(id: string): boolean {
  return cloudflareInstanceIdPattern.test(id) && !reservedCloudflareInstanceIds.has(id) && !/^cf_[0-9a-f]{64}$/.test(id)
}

const cloudflareStatusMap: Record<string, WorkflowRunStatus> = {
  cancelled: "cancelled",
  complete: "completed",
  completed: "completed",
  errored: "failed",
  failed: "failed",
  queued: "queued",
  running: "running",
  success: "completed",
  terminated: "failed",
}

function normalizeCloudflareStatus(status: unknown): WorkflowRunStatus {
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  const value = typeof status === "object" && status && Object.hasOwn(status, "status")
    ? (status as { status?: unknown }).status
    : status
  const normalized = String(value || "").toLowerCase()
  return Object.hasOwn(cloudflareStatusMap, normalized) ? cloudflareStatusMap[normalized]! : "unknown"
}

function ownSerializedOutput(metadata: unknown) {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "output")) return undefined
  // SAFETY: The guards establish a non-null object with an own output property, whose value remains unknown.
  const output = (metadata as { output?: unknown }).output
  return isSerializedResponse(output) ? output : undefined
}

function hasUnknownWorkflowAcknowledgement(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  const details = (error as { details?: unknown }).details
  return Boolean(details && typeof details === "object"
    // SAFETY: Workflow provider normalization establishes the asserted run contract.
    && (details as { acknowledgement?: unknown }).acknowledgement === "unknown")
}

function createCloudflareAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: () => unsupportedOperation("cloudflare", "cancellation"),
    async get({ event, id, name }) {
      const binding = resolveCloudflareInspectionBinding(event, config.binding, name)
      if (binding) {
        // Cloudflare cannot store a run under an id that it rejects.
        if (!isCloudflareInstanceId(id)) return { id, provider: "cloudflare", status: "unknown" }
        const instance = await runWorkflowProviderOperation("cloudflare", "get", () => binding.get(id))
        const metadata = await runWorkflowProviderOperation("cloudflare", "status", () => instance.status())
        const output = ownSerializedOutput(metadata)
        return {
          id,
          metadata,
          provider: "cloudflare",
          result: output ? deserializeResponse(output) : undefined,
          status: normalizeCloudflareStatus(metadata),
        }
      }

      return await inlineAdapter(config).get({ event, id, name })
    },
    async run({ definition, event, id, name, options, payload }) {
      // Check in `vite dev` too, where the run can be inline, so the id fails before deployment.
      if (!isCloudflareInstanceId(id)) throw workflowErrorDiagnostics.WORKFLOW_R0037({ id })
      const binding = resolveCloudflareBinding(event, config.binding, name, definition)
      if (binding) {
        resolveDispatchObserver(event)?.()
        const start = () => runWorkflowProviderOperation(
          "cloudflare",
          "create",
          async () => normalizeCloudflareWorkflowStart((await binding.createBatch([{ id, params: payload }]))[0] || await binding.get(id), id),
          { acknowledgementUnknown: (_error, status) => status === undefined },
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
        return {
          id: instance.id,
          payload,
          provider: "cloudflare",
          status: "queued",
        }
      }

      return await inlineAdapter(config).run({ definition, event, id, name, options, payload })
    },
    resume: () => unsupportedOperation("cloudflare", "signals"),
  }
}

function createOpenWorkflowAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: async ({ id, name }) => await cancelOpenWorkflowRun(config, name, id),
    get: async ({ id, name }) => await getOpenWorkflowRun(config, name, id),
    resume: () => unsupportedOperation("openworkflow", "signals"),
    run: async ({ definition, event, name, options, payload }) => await runOpenWorkflow(config, name, payload, definition, options, resolveDispatchObserver(event)),
  }
}

function inlineAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: () => unsupportedOperation(config.provider, "cancellation"),
    async get({ id, name }: GetWorkflowAdapterContext): Promise<WorkflowRun<unknown, unknown>> {
      const run = getWorkflowRunState(name, id)
      if (run) {
        if (run.status === "running") {
          return {
            id,
            provider: config.provider,
            status: "running",
          }
        }
        return {
          id,
          metadata: run.error,
          provider: config.provider,
          result: isSerializedResponse(run.result) ? deserializeResponse(run.result) : run.result,
          status: run.status,
        }
      }
      return {
        id,
        provider: config.provider,
        status: "unknown",
      }
    },
    async run<TPayload = unknown, TResult = unknown>({ definition, event, id, name, payload }: RunWorkflowAdapterContext<TPayload, TResult>) {
      const existing = getWorkflowRunState(name, id)
      if (existing) {
        return {
          id,
          metadata: existing.error ?? (config.provider === "vercel" ? { mode: "inline", workflow: getVercelWorkflowName(name) } : undefined),
          payload: existing.payload as TPayload | undefined,
          provider: config.provider,
          result: (isSerializedResponse(existing.result) ? deserializeResponse(existing.result) : existing.result) as TResult | undefined,
          status: existing.status === "running" ? "queued" : existing.status,
        }
      }
      resolveDispatchObserver(event)?.()
      // Only `vite dev` has a recorder. It records the run in the dev history.
      const recordRun = getWorkflowDevRecorder()?.start(name, id, config.provider)
      const execute = () => runSerializedWorkflowHandler({
        id,
        name,
        payload,
        provider: config.provider,
      // SAFETY: Workflow provider normalization establishes the asserted run contract.
      }, definition as never)
      const run = Promise.resolve()
        .then(() => recordRun ? recordRun(execute) : execute())
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        .then(result => ({ result, status: "completed" as const }))
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        .catch(error => ({ error, status: "failed" as const }))
      const runState = setWorkflowRun(name, id, run, payload, true)
      const waitUntil = resolveWaitUntil(event)
      if (waitUntil) {
        waitUntil(runState.promise)
      }

      return {
        id,
        metadata: config.provider === "vercel" ? { mode: "inline", workflow: getVercelWorkflowName(name) } : undefined,
        payload,
        provider: config.provider,
        status: "queued",
      }
    },
    resume: () => unsupportedOperation(config.provider, "signals"),
  }
}

function createVercelAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  const fallback = inlineAdapter(config)
  return {
    async cancel({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      if (!definition?.options?.native) {
        return await fallback.cancel({ event: undefined, id, name })
      }
      return await cancelVercelWorkflow(name, definition, id)
    },
    async get({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      return definition?.options?.native
        ? await inspectVercelWorkflowRun(name, definition, id)
        : await fallback.get({ event: undefined, id, name })
    },
    resume: async (token, payload) => await resumeVercelWorkflowSignal(token, payload),
    async run({ definition, event, id, name, options, payload }) {
      if (!definition.options?.native) {
        return await fallback.run({ definition, event, id, name, options, payload })
      }
      return await startVercelWorkflow(name, definition, payload, resolveSettlementObserver(event), resolveDispatchObserver(event))
    },
  }
}

export function getWorkflowRuntimeAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  if (config.provider === "cloudflare") {
    return createCloudflareAdapter(config)
  }
  if (config.provider === "openworkflow") {
    return createOpenWorkflowAdapter(config)
  }
  return createVercelAdapter(config)
}
