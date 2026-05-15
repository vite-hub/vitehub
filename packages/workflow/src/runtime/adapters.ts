import { getCloudflareEnv, resolveWaitUntil } from "@vitehub/internal/runtime/cloudflare-env"

import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { runWorkflowHandler } from "./execute.ts"
import { getOpenWorkflowRun, runOpenWorkflow } from "./openworkflow.ts"
import { getVercelWorkflowRunState, setVercelWorkflowRunState } from "./vercel-state.ts"
import { getWorkflowRunState, setWorkflowRun } from "./state.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowDefinition, WorkflowDeferOptions, WorkflowRun, WorkflowRunStatus } from "../types.ts"

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
  get<TPayload = unknown, TResult = unknown>(context: GetWorkflowAdapterContext): Promise<WorkflowRun<TPayload, TResult>>
  run<TPayload = unknown, TResult = unknown>(context: RunWorkflowAdapterContext<TPayload, TResult>): Promise<WorkflowRun<TPayload, TResult>>
}

function resolveCloudflareBinding(event: unknown, binding: string | undefined, name: string) {
  const bindingName = binding || getCloudflareWorkflowBindingName(name)
  return getCloudflareEnv(event)?.[bindingName] as CloudflareWorkflowBinding | undefined
}

const cloudflareStatusMap: Record<string, WorkflowRunStatus> = {
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
    async get({ event, id, name }) {
      const binding = resolveCloudflareBinding(event, config.binding, name)
      if (binding) {
        const instance = await binding.get(id)
        const metadata = await instance.status()
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
      const binding = resolveCloudflareBinding(event, config.binding, name)
      if (binding) {
        const start = binding.create({ id, params: payload })
        const waitUntil = options.deferred ? resolveWaitUntil(event) : undefined
        if (waitUntil) {
          waitUntil(start)
        }
        const instance = await start
        return {
          id: instance.id,
          metadata: await instance.status(),
          payload,
          provider: "cloudflare",
          status: "queued",
        }
      }

      return await inlineAdapter(config).run({ definition, event, id, name, options, payload })
    },
  }
}

function createOpenWorkflowAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
    get: async ({ id, name }) => await getOpenWorkflowRun(config, name, id),
    run: async ({ definition, name, options, payload }) => await runOpenWorkflow(config, name, payload, definition, options),
  }
}

function inlineAdapter(config: ResolvedWorkflowOptions): WorkflowRuntimeAdapter {
  return {
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

      if (config.provider === "vercel") {
        const persisted = await getVercelWorkflowRunState(name, id)
        if (persisted) {
          return {
            id,
            metadata: persisted.error,
            provider: "vercel",
            result: persisted.result as TResult,
            status: persisted.status,
          }
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
      const persistStarted = config.provider === "vercel"
        ? setVercelWorkflowRunState(name, id, { status: "running" }).catch(() => {})
        : Promise.resolve()
      const persistFinished = config.provider === "vercel"
        ? runState.promise.then(result => setVercelWorkflowRunState(name, id, result)).catch(() => {})
        : Promise.resolve()
      const waitUntil = resolveWaitUntil(event)
      if (waitUntil) {
        waitUntil(Promise.all([runState.promise, persistFinished]))
      }
      await persistStarted

      return {
        id,
        metadata: config.provider === "vercel" ? { workflow: getVercelWorkflowName(name) } : undefined,
        payload,
        provider: config.provider,
        status: "queued",
      }
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
  return inlineAdapter(config)
}
