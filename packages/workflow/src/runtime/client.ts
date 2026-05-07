import { getCloudflareEnv, resolveWaitUntil } from "@vitehub/internal/runtime/cloudflare-env"
import { randomId } from "@vitehub/internal/runtime/random"

import { normalizeWorkflowOptions } from "../config.ts"
import { WorkflowError } from "../errors.ts"
import { getCloudflareWorkflowBindingName } from "../integrations/cloudflare.ts"
import { getVercelWorkflowName } from "../integrations/vercel.ts"

import { runWorkflowHandler } from "./execute.ts"
import { getWorkflowRunState, getWorkflowRuntimeConfig, getWorkflowRuntimeEvent, loadWorkflowDefinition, registerInlineWorkflowDefinition, runWithWorkflowRuntimeEvent, setWorkflowRun } from "./state.ts"
import { getVercelWorkflowRunState, setVercelWorkflowRunState } from "./vercel-state.ts"

import type { CloudflareWorkflowBinding, ResolvedWorkflowOptions, WorkflowCreateOptions, WorkflowDeferOptions, WorkflowHandle, WorkflowHandler, WorkflowRun, WorkflowRunIdValue, WorkflowRunStatus, WorkflowStartOptions } from "../types.ts"

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
  terminated: "failed",
}

function normalizeCloudflareStatus(status: unknown): WorkflowRunStatus {
  const value = typeof status === "object" && status ? (status as { status?: unknown }).status : status
  return cloudflareStatusMap[String(value || "").toLowerCase()] || "unknown"
}

function normalizeWorkflowRunIdValue(value: WorkflowRunIdValue): unknown {
  if (value === undefined) {
    return null
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeWorkflowRunIdValue(item))
  }
  const record = value as { readonly [key: string]: WorkflowRunIdValue }
  return Object.fromEntries(
    Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => [key, normalizeWorkflowRunIdValue(record[key])]),
  )
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function createStableWorkflowRunId(name: string, value: WorkflowRunIdValue): Promise<string> {
  const normalized = JSON.stringify(normalizeWorkflowRunIdValue(value))
  const hash = await sha256Hex(`${name}:${normalized}`)
  const prefix = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow"
  return `${prefix}-${hash.slice(0, 32)}`
}

async function resolveWorkflowStartOptions<TPayload>(
  name: string,
  payload: TPayload | undefined,
  createOptions: WorkflowCreateOptions<TPayload> | undefined,
  startOptions: WorkflowStartOptions,
): Promise<WorkflowStartOptions> {
  if (startOptions.id || !createOptions?.id) {
    return startOptions
  }

  return {
    ...startOptions,
    id: await createStableWorkflowRunId(name, await createOptions.id({ name, payload })),
  }
}

export function createWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  options?: WorkflowCreateOptions<TPayload>,
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  handler: WorkflowHandler<TPayload, TResult>,
  options?: WorkflowCreateOptions<TPayload>,
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  handlerOrOptions?: WorkflowCreateOptions<TPayload> | WorkflowHandler<TPayload, TResult>,
  options?: WorkflowCreateOptions<TPayload>,
): WorkflowHandle<TPayload, TResult> {
  if (!name || typeof name !== "string") {
    throw new TypeError("`createWorkflow()` requires a workflow name.")
  }

  const handler = typeof handlerOrOptions === "function" ? handlerOrOptions : undefined
  const createOptions = typeof handlerOrOptions === "function" ? options : handlerOrOptions

  if (handler !== undefined) {
    registerInlineWorkflowDefinition(name, { handler: handler as WorkflowHandler })
  }
  else if (handlerOrOptions !== undefined && (typeof handlerOrOptions !== "object" || handlerOrOptions === null)) {
    throw new TypeError("`createWorkflow()` options must be an object.")
  }

  return {
    name,
    defer: async (payload?: TPayload, options: WorkflowStartOptions = {}) => deferWorkflow<TPayload>(
      name,
      payload,
      await resolveWorkflowStartOptions(name, payload, createOptions, options),
    ),
    getRun: (id: string) => getWorkflowRun<TPayload, TResult>(name, id),
    run: async (payload?: TPayload, options: WorkflowStartOptions = {}) => runWorkflow<TPayload, TResult>(
      name,
      payload,
      await resolveWorkflowStartOptions(name, payload, createOptions, options),
    ),
  }
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
  const definition = await loadRequiredWorkflowDefinition(name)
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

  const run = Promise.resolve()
    .then(() => runWorkflowHandler({
      id,
      name,
      payload: payload as TPayload,
      provider: config.provider,
    }, definition as never) as TResult | Promise<TResult>)
    .then(result => ({ result, status: "completed" as const }))
    .catch(error => ({ error, status: "failed" as const }))
  const runState = setWorkflowRun(name, id, run)
  const persistStarted = config.provider === "vercel"
    ? setVercelWorkflowRunState(name, id, { status: "running" }).catch(() => {})
    : Promise.resolve()
  const persistFinished = config.provider === "vercel"
    ? runState.promise.then(result => setVercelWorkflowRunState(name, id, result)).catch(() => {})
    : Promise.resolve()
  const waitUntil = resolveWaitUntil(getWorkflowRuntimeEvent())
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
}

export function deferWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowStartOptions = {},
): Promise<WorkflowRun<TPayload>> {
  const request = getWorkflowRuntimeEvent()
  return runWithWorkflowRuntimeEvent(request, () => runWorkflow<TPayload>(name, payload, { ...options, deferred: true }))
}
