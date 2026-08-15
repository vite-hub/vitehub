import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { createWorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { runWorkflowHandler } from "./execute.ts"
import { getOpenWorkflowRun, runOpenWorkflow } from "./openworkflow.ts"
import { runWorkflowProviderOperation, safeWorkflowName } from "./provider-operation.ts"
import { getWorkflowRunState, loadWorkflowDefinition, setWorkflowRun } from "./state.ts"
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
  cancel<TPayload = unknown, TResult = unknown>(context: GetWorkflowAdapterContext): Promise<WorkflowRun<TPayload, TResult>>
  get<TPayload = unknown, TResult = unknown>(context: GetWorkflowAdapterContext): Promise<WorkflowRun<TPayload, TResult>>
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
  const bindingName = definition?.internalAgentInvocationRecovery
    ? getCloudflareWorkflowBindingName(name)
    : binding || getCloudflareWorkflowBindingName(name)
  return getCloudflareEnv(event)?.[bindingName] as CloudflareWorkflowBinding | undefined
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
  const value = typeof status === "object" && status ? (status as { status?: unknown }).status : status
  return cloudflareStatusMap[String(value || "").toLowerCase()] || "unknown"
}

function createCloudflareAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    cancel: () => unsupportedOperation("cloudflare", "cancellation"),
    async get({ event, id, name }) {
      const definition = await loadWorkflowDefinition(name)
      const binding = resolveCloudflareBinding(event, config.binding, name, definition)
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
        const creation = start().catch(() => start())
        const waitUntil = options.deferred ? resolveWaitUntil(event) : undefined
        if (waitUntil) {
          waitUntil(creation)
        }
        const instance = await creation
        return {
          id: instance.id,
          metadata: await runWorkflowProviderOperation("cloudflare", "status", () => instance.status()),
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
    async get<TPayload = unknown, TResult = unknown>({ id, name }: GetWorkflowAdapterContext): Promise<WorkflowRun<TPayload, TResult>> {
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
          result: run.result as TResult,
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
        }, definition as never))
        .then(result => ({ result, status: "completed" as const }))
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
    async cancel<TPayload = unknown, TResult = unknown>({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      if (!definition?.options?.native) {
        return await fallback.cancel({ event: undefined, id, name })
      }
      return await cancelVercelWorkflow<TPayload, TResult>(name, definition as WorkflowDefinition<TPayload, TResult>, id)
    },
    async get<TPayload = unknown, TResult = unknown>({ id, name }: GetWorkflowAdapterContext) {
      const definition = await loadWorkflowDefinition(name)
      return definition?.options?.native
        ? await inspectVercelWorkflowRun<TPayload, TResult>(name, definition as WorkflowDefinition<TPayload, TResult>, id)
        : await fallback.get<TPayload, TResult>({ event: undefined, id, name })
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
