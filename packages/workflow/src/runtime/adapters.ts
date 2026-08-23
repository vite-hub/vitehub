import { hasRuntimeType } from "../internal/runtime-type.ts"
import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { createWorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { runWorkflowHandler } from "./execute.ts"
import { getOpenWorkflowRun, runOpenWorkflow } from "./openworkflow.ts"
import { runWorkflowProviderOperation, safeWorkflowName } from "./provider-operation.ts"
import { getWorkflowRunState, getWorkflowRuntimeRegistry, loadWorkflowDefinition, setWorkflowRun } from "./state.ts"
import { cancelVercelWorkflow, inspectVercelWorkflowRun, resumeVercelWorkflowSignal, startVercelWorkflow } from "./vercel.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDeferOptions, WorkflowRun, WorkflowRunStatus, WorkflowSignalResult } from "../types.ts"
import type { WorkflowOperationName } from "../errors.ts"

interface RunWorkflowAdapterContext<TPayload = unknown, TResult = unknown> {
  definition: WorkflowDefinition<TPayload, TResult>
  event: unknown
  id: string
  name: string
  options: WorkflowDeferOptions
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

function unsupportedOperation(provider: "cloudflare" | "openworkflow" | "vercel", operation: WorkflowOperationName): never {
  throw createWorkflowError({
    code: "WORKFLOW_OPERATION_UNSUPPORTED",
    details: { operation, provider },
  })
}

function resolveCloudflareBinding(event: unknown, binding: string | undefined, name: string, definition?: { internalAgentInvocationRecovery?: true }) {
  const env = getCloudflareEnv(event)
  const bindingName = definition?.internalAgentInvocationRecovery
    ? getCloudflareWorkflowBindingName(name)
    : binding || getCloudflareWorkflowBindingName(name)
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  return env?.[bindingName] as CloudflareWorkflowBinding | undefined
}

function resolveCloudflareInspectionBinding(event: unknown, binding: string | undefined, name: string) {
  return resolveCloudflareBinding(event, binding, name, getWorkflowRuntimeRegistry()?.[name])
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
  const value = hasRuntimeType(status, "object") && status ? (status as { status?: unknown }).status : status
  return cloudflareStatusMap[String(value || "").toLowerCase()] || "unknown"
}

function hasUnknownWorkflowAcknowledgement(error: unknown): boolean {
  if (!error || !hasRuntimeType(error, "object")) return false
  // SAFETY: Workflow provider normalization establishes the asserted run contract.
  const details = (error as { details?: unknown }).details
  return Boolean(details && hasRuntimeType(details, "object")
    // SAFETY: Workflow provider normalization establishes the asserted run contract.
    && (details as { acknowledgement?: unknown }).acknowledgement === "unknown")
}

function createCloudflareAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: () => unsupportedOperation("cloudflare", "cancellation"),
    async get({ event, id, name }) {
      const binding = resolveCloudflareInspectionBinding(event, config.binding, name)
      if (binding) {
        const instance = await runWorkflowProviderOperation("cloudflare", "get", () => binding.get(id))
        const metadata = await runWorkflowProviderOperation("cloudflare", "status", () => instance.status())
        return {
          id,
          metadata,
          provider: "cloudflare",
          status: normalizeCloudflareStatus(metadata),
        }
      }

      return await inlineAdapter(config).get({ event, id, name })
    },
    async run({ definition, event, id, name, options, payload }) {
      const binding = resolveCloudflareBinding(event, config.binding, name, definition)
      if (binding) {
        const start = () => runWorkflowProviderOperation(
          "cloudflare",
          "create",
          async () => (await binding.createBatch([{ id, params: payload }]))[0] || await binding.get(id),
          { acknowledgementUnknown: (_error, status) => status === undefined },
        )
        const creation = start().catch(async (firstError) => {
          try {
            return await start()
          }
          catch (retryError) {
            if (hasUnknownWorkflowAcknowledgement(firstError)) throw firstError
            throw retryError
          }
        })
        const waitUntil = options.deferred ? resolveWaitUntil(event) : undefined
        if (waitUntil) {
          waitUntil(creation)
        }
        const instance = await creation
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
    cancel: () => unsupportedOperation("openworkflow", "cancellation"),
    get: async ({ id, name }) => await getOpenWorkflowRun(config, name, id),
    resume: () => unsupportedOperation("openworkflow", "signals"),
    run: async ({ definition, name, options, payload }) => await runOpenWorkflow(config, name, payload, definition, options),
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
          result: run.result,
          status: run.status,
        }
      }
      return {
        id,
        provider: config.provider,
        status: "unknown",
      }
    },
    async run({ definition, event, id, name, payload }) {
      const run = Promise.resolve()
        .then(() => runWorkflowHandler({
          id,
          name,
          payload,
          provider: config.provider,
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        }, definition as never))
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        .then(result => ({ result, status: "completed" as const }))
        // SAFETY: Workflow provider normalization establishes the asserted run contract.
        .catch(error => ({ error, status: "failed" as const }))
      const runState = setWorkflowRun(name, id, run)
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
      if (options.id) {
        throw createWorkflowError({
          code: "WORKFLOW_RUN_ID_UNSUPPORTED",
          details: { ...(safeWorkflowName(name) ? { name } : {}), provider: "vercel" },
        })
      }
      return await startVercelWorkflow(name, definition, payload)
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
