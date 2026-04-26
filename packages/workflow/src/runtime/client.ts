import { getCloudflareEnv, resolveWaitUntil } from "@vitehub/internal/runtime/cloudflare-env"
import { randomId } from "@vitehub/internal/runtime/random"

import { normalizeWorkflowOptions } from "../config.ts"
import { WorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { getWorkflowRunState, getWorkflowRuntimeConfig, getWorkflowRuntimeEvent, loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRun } from "./state.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowDeferOptions, WorkflowProviderOptions, WorkflowRun, WorkflowRunStatus, WorkflowStartOptions } from "../types.ts"

function resolveCloudflareBinding(binding: string | undefined, name: string) {
  const bindingName = binding || getCloudflareWorkflowBindingName(name)
  return getCloudflareEnv(getWorkflowRuntimeEvent())?.[bindingName] as CloudflareWorkflowBinding | undefined
}

function getActiveWorkflowConfig(): false | ResolvedWorkflowOptions {
  const config = getWorkflowRuntimeConfig()
  if (config === false) {
    return false
  }

  return config || normalizeWorkflowOptions(undefined, { hosting: "vercel" })!
}

async function loadRequiredWorkflowDefinition(name: string) {
  const definition = await loadWorkflowDefinition(name)
  if (!definition) {
    throw new WorkflowError(`Unknown workflow definition: ${name}`, {
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
      details: { name },
      httpStatus: 404,
    })
  }
  return definition
}

const cloudflareStatusMap: Record<string, WorkflowRunStatus> = {
  complete: "completed",
  completed: "completed",
  errored: "failed",
  failed: "failed",
  queued: "queued",
  running: "running",
  success: "completed",
  terminated: "completed",
}

function normalizeCloudflareStatus(status: unknown): WorkflowRunStatus {
  const value = typeof status === "object" && status ? (status as { status?: unknown }).status : status
  return cloudflareStatusMap[String(value || "").toLowerCase()] || "unknown"
}

export async function createWorkflow(options: WorkflowProviderOptions): Promise<WorkflowProviderOptions> {
  return options
}

export async function runWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowDeferOptions = {},
): Promise<WorkflowRun<TPayload, TResult>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw new WorkflowError("Workflow is disabled.", {
      code: "WORKFLOW_DISABLED",
      httpStatus: 400,
    })
  }

  const id = options.id || randomId("wrun")
  if (config.provider === "cloudflare") {
    const binding = resolveCloudflareBinding(config.binding, name)
    if (binding) {
      const start = binding.create({ id, params: payload })
      const waitUntil = options.deferred ? resolveWaitUntil(getWorkflowRuntimeEvent()) : undefined
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
  }

  const definition = await loadRequiredWorkflowDefinition(name)
  const run = Promise.resolve(definition.handler({
    id,
    name,
    payload: payload as TPayload,
    provider: config.provider,
  }) as TResult | Promise<TResult>)
    .then(result => ({ result, status: "completed" as const }))
    .catch(error => ({ error, status: "failed" as const }))
  const runState = setWorkflowRun(name, id, run)
  const waitUntil = resolveWaitUntil(getWorkflowRuntimeEvent())
  if (waitUntil) {
    waitUntil(runState.promise)
  }

  return {
    id,
    metadata: config.provider === "vercel" ? { workflow: getVercelWorkflowName(name) } : undefined,
    payload,
    provider: config.provider,
    status: "queued",
  }
}

export async function getWorkflowRun<TPayload = unknown, TResult = unknown>(name: string, id: string): Promise<WorkflowRun<TPayload, TResult>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw new WorkflowError("Workflow is disabled.", {
      code: "WORKFLOW_DISABLED",
      httpStatus: 400,
    })
  }

  if (config.provider === "cloudflare") {
    const binding = resolveCloudflareBinding(config.binding, name)
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
  }

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
}

export function deferWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowStartOptions = {},
): Promise<WorkflowRun<TPayload>> {
  const request = getWorkflowRuntimeEvent()
  return runWithWorkflowRuntimeEvent(request, () => runWorkflow<TPayload>(name, payload, { ...options, deferred: true }))
}
