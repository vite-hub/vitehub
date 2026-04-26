import { normalizeWorkflowOptions } from "../config.ts"
import { WorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { getWorkflowRunState, getWorkflowRuntimeConfig, getWorkflowRuntimeEvent, loadWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRun } from "./state.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowProviderOptions, WorkflowRun, WorkflowRunStatus, WorkflowStartInput, WorkflowStartOptions } from "../types.ts"

function randomId() {
  return `wrun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function getCloudflareEnv(event: unknown) {
  const target = event as {
    context?: { cloudflare?: { env?: Record<string, unknown> }, _platform?: { cloudflare?: { env?: Record<string, unknown> } } }
    env?: Record<string, unknown>
    req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
  } | undefined
  return target?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || (globalThis as { __env__?: Record<string, unknown> }).__env__
}

function resolveCloudflareBinding(binding: string | undefined, name: string) {
  const bindingName = binding || getCloudflareWorkflowBindingName(name)
  return getCloudflareEnv(getWorkflowRuntimeEvent())?.[bindingName] as CloudflareWorkflowBinding | undefined
}

function resolveWaitUntil(event: unknown): ((promise: Promise<unknown>) => void) | undefined {
  const target = event as {
    waitUntil?: (promise: Promise<unknown>) => void
    context?: {
      waitUntil?: (promise: Promise<unknown>) => void
      cloudflare?: {
        context?: { waitUntil?: (promise: Promise<unknown>) => void }
        waitUntil?: (promise: Promise<unknown>) => void
      }
      _platform?: {
        cloudflare?: {
          context?: { waitUntil?: (promise: Promise<unknown>) => void }
          waitUntil?: (promise: Promise<unknown>) => void
        }
      }
    }
    req?: {
      waitUntil?: (promise: Promise<unknown>) => void
      runtime?: {
        cloudflare?: {
          context?: { waitUntil?: (promise: Promise<unknown>) => void }
          waitUntil?: (promise: Promise<unknown>) => void
        }
      }
    }
  } | undefined

  const bindWaitUntil = (owner: { waitUntil?: (promise: Promise<unknown>) => void } | undefined) =>
    typeof owner?.waitUntil === "function" ? owner.waitUntil.bind(owner) : undefined

  return bindWaitUntil(target)
    || bindWaitUntil(target?.context)
    || bindWaitUntil(target?.context?.cloudflare)
    || bindWaitUntil(target?.context?.cloudflare?.context)
    || bindWaitUntil(target?.context?._platform?.cloudflare)
    || bindWaitUntil(target?.context?._platform?.cloudflare?.context)
    || bindWaitUntil(target?.req)
    || bindWaitUntil(target?.req?.runtime?.cloudflare)
    || bindWaitUntil(target?.req?.runtime?.cloudflare?.context)
}

function getActiveWorkflowConfig(): false | ResolvedWorkflowOptions {
  const config = getWorkflowRuntimeConfig()
  if (config === false) {
    return false
  }

  return config || normalizeWorkflowOptions(undefined, { hosting: "vercel" })!
}

function normalizeStartInput<TPayload>(input?: TPayload | WorkflowStartInput<TPayload>, options: WorkflowStartOptions = {}) {
  if (input && typeof input === "object" && !Array.isArray(input) && ("payload" in input || "id" in input)) {
    const envelope = input as WorkflowStartInput<TPayload>
    return {
      id: options.id || envelope.id || randomId(),
      payload: envelope.payload as TPayload,
    }
  }

  return {
    id: options.id || randomId(),
    payload: input as TPayload,
  }
}

async function runDefinition<TPayload, TResult>(name: string, provider: WorkflowProviderOptions["provider"], id: string, payload: TPayload, step?: unknown) {
  const definition = await loadWorkflowDefinition(name)
  if (!definition) {
    throw new WorkflowError(`Unknown workflow definition: ${name}`, {
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
      details: { name },
      httpStatus: 404,
    })
  }

  return await definition.handler({
    id,
    name,
    payload,
    provider,
    step,
  }) as TResult
}

function normalizeCloudflareStatus(status: unknown): WorkflowRunStatus {
  const value = typeof status === "object" && status ? (status as { status?: unknown }).status : status
  switch (String(value || "").toLowerCase()) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
      return String(value).toLowerCase() as WorkflowRunStatus
    case "complete":
    case "success":
    case "terminated":
      return "completed"
    case "errored":
      return "failed"
    default:
      return "unknown"
  }
}

export async function createWorkflow(options: WorkflowProviderOptions): Promise<WorkflowProviderOptions> {
  return options
}

export async function runWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  input?: TPayload | WorkflowStartInput<TPayload>,
  options: WorkflowStartOptions = {},
): Promise<WorkflowRun<TPayload, TResult>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw new WorkflowError("Workflow is disabled.", {
      code: "WORKFLOW_DISABLED",
      httpStatus: 400,
    })
  }

  const normalized = normalizeStartInput(input, options)
  if (config.provider === "cloudflare") {
    const binding = resolveCloudflareBinding(config.binding, name)
    if (binding) {
      const instance = await binding.create({ id: normalized.id, params: normalized.payload })
      return {
        id: instance.id,
        metadata: await instance.status().catch(() => undefined),
        payload: normalized.payload,
        provider: "cloudflare",
        status: "queued",
      }
    }
  }

  const run = runDefinition<TPayload, TResult>(name, config.provider, normalized.id, normalized.payload)
    .then(result => ({ result, status: "completed" as const }))
    .catch(error => ({ error, status: "failed" as const }))
  setWorkflowRun(normalized.id, run)
  const waitUntil = (options as WorkflowStartOptions & { deferred?: boolean }).deferred ? undefined : resolveWaitUntil(getWorkflowRuntimeEvent())
  if (waitUntil) {
    waitUntil(run)
  }

  return {
    id: normalized.id,
    metadata: config.provider === "vercel" ? { workflow: getVercelWorkflowName(name) } : undefined,
    payload: normalized.payload,
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

  const run = getWorkflowRunState(id)
  if (run && typeof (run as Promise<unknown>).then === "function") {
    const resolved = await run as { result?: TResult, status: WorkflowRunStatus, error?: unknown }
    return {
      id,
      metadata: resolved.error,
      provider: config.provider,
      result: resolved.result,
      status: resolved.status,
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
  input?: TPayload | WorkflowStartInput<TPayload>,
  options: WorkflowStartOptions = {},
): void {
  const request = getWorkflowRuntimeEvent()
  const promise = runWithWorkflowRuntimeEvent(request, () => runWorkflow(name, input, { ...options, deferred: true } as WorkflowStartOptions))
    .catch(error => console.error(`[vitehub] Deferred workflow dispatch failed for "${name}"`, error))
  const waitUntil = resolveWaitUntil(request)
  if (typeof waitUntil === "function") {
    waitUntil(promise)
  }
}
