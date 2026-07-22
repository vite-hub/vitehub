import { randomId } from "@vite-hub/internal/runtime/random"

import { normalizeWorkflowOptions } from "../config.ts"
import { createWorkflowError } from "../errors.ts"

import { getWorkflowRuntimeAdapter } from "./adapters.ts"
import { safeWorkflowName } from "./provider-operation.ts"
import { getWorkflowRuntimeConfig, getWorkflowRuntimeEvent, loadWorkflowDefinition, registerInlineWorkflowDefinition, runWithWorkflowRuntimeEvent } from "./state.ts"

import type { ResolvedWorkflowOptions, WorkflowCreateOptions, WorkflowDeferOptions, WorkflowDefinition, WorkflowHandle, WorkflowHandler, WorkflowRun, WorkflowRunIdValue, WorkflowSignalResult, WorkflowStartOptions } from "../types.ts"

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
    throw createWorkflowError({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
      details: safeWorkflowName(name) ? { name } : undefined,
    })
  }
  return definition
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
  options: WorkflowCreateOptions<TPayload, TResult> & { handler: WorkflowHandler<TPayload, TResult>, name: string },
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  options?: WorkflowCreateOptions<TPayload, TResult>,
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown, TResult = unknown>(
  name: string,
  handler: WorkflowHandler<TPayload, TResult>,
  options?: WorkflowCreateOptions<TPayload, TResult>,
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown, TResult = unknown>(
  nameOrOptions: string | WorkflowCreateOptions<TPayload, TResult>,
  handlerOrOptions?: WorkflowCreateOptions<TPayload, TResult> | WorkflowHandler<TPayload, TResult>,
  options?: WorkflowCreateOptions<TPayload, TResult>,
): WorkflowHandle<TPayload, TResult> {
  if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
    const createOptions = nameOrOptions
    const { handler, name } = createOptions
    if (!name || typeof name !== "string") {
      throw new TypeError("`createWorkflow()` requires a workflow name.")
    }
    if (typeof handler !== "function") {
      throw new TypeError("`createWorkflow()` requires a workflow handler.")
    }
    registerInlineWorkflowDefinition(name, { handler: handler as WorkflowHandler })
    return {
      cancel: (id: string) => cancelWorkflow<TPayload, TResult>(name, id),
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

  const name = nameOrOptions
  if (!name || typeof name !== "string") {
    throw new TypeError("`createWorkflow()` requires a workflow name.")
  }

  const handler = typeof handlerOrOptions === "function"
    ? handlerOrOptions
    : typeof handlerOrOptions === "object" && handlerOrOptions !== null
      ? handlerOrOptions.handler
      : undefined
  const createOptions = typeof handlerOrOptions === "function" ? options : handlerOrOptions

  if (handler !== undefined) {
    if (typeof handler !== "function") {
      throw new TypeError("`createWorkflow()` requires a workflow handler.")
    }
    registerInlineWorkflowDefinition(name, { handler: handler as WorkflowHandler })
  }
  else if (handlerOrOptions !== undefined && (typeof handlerOrOptions !== "object" || handlerOrOptions === null)) {
    throw new TypeError("`createWorkflow()` options must be an object.")
  }

  return {
    cancel: (id: string) => cancelWorkflow<TPayload, TResult>(name, id),
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
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  const id = options.id || randomId("wrun")
  const definition = await loadRequiredWorkflowDefinition(name)
  return await getWorkflowRuntimeAdapter(config).run<TPayload, TResult>({
    definition: definition as WorkflowDefinition<TPayload, TResult>,
    event: getWorkflowRuntimeEvent(),
    id,
    name,
    options,
    payload,
  })
}

export async function getWorkflowRun<TPayload = unknown, TResult = unknown>(name: string, id: string): Promise<WorkflowRun<TPayload, TResult>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  return await getWorkflowRuntimeAdapter(config).get<TPayload, TResult>({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

export async function cancelWorkflow<TPayload = unknown, TResult = unknown>(name: string, id: string): Promise<WorkflowRun<TPayload, TResult>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  await loadRequiredWorkflowDefinition(name)
  return await getWorkflowRuntimeAdapter(config).cancel<TPayload, TResult>({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

export async function resumeWorkflowSignal<TPayload = unknown>(token: string, payload: TPayload): Promise<WorkflowSignalResult> {
  if (!token || typeof token !== "string") {
    throw new TypeError("`resumeWorkflowSignal()` requires an opaque signal token.")
  }
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }
  return await getWorkflowRuntimeAdapter(config).resume(token, payload)
}

export function deferWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowStartOptions = {},
): Promise<WorkflowRun<TPayload>> {
  const request = getWorkflowRuntimeEvent()
  return runWithWorkflowRuntimeEvent(request, () => runWorkflow<TPayload>(name, payload, { ...options, deferred: true }))
}
