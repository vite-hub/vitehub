import { hasRuntimeType } from "../internal/runtime-type.ts"
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
  if (value === null || !hasRuntimeType(value, "object")) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeWorkflowRunIdValue(item))
  }
  // SAFETY: Workflow definition registration establishes the asserted typed handle contract.
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
  options: WorkflowCreateOptions<TPayload, TResult> & { handler: WorkflowHandler<TPayload, TResult> },
): WorkflowHandle<TPayload, TResult>
export function createWorkflow<TPayload = unknown>(
  name: string,
  options?: Omit<WorkflowCreateOptions<TPayload, unknown>, "handler"> & { handler?: never },
): WorkflowHandle<TPayload, unknown>
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
  if (hasRuntimeType(nameOrOptions, "object") && nameOrOptions !== null) {
    const createOptions = nameOrOptions
    const { handler, name } = createOptions
    if (!name || !hasRuntimeType(name, "string")) {
      throw new TypeError("`createWorkflow()` requires a workflow name.")
    }
    if (!hasRuntimeType(handler, "function")) {
      throw new TypeError("`createWorkflow()` requires a workflow handler.")
    }
    registerInlineWorkflowDefinition(name, {
      // SAFETY: Workflow definition registration establishes the asserted typed handle contract.
      handler: handler as WorkflowHandler,
      ...(createOptions.rootStep === undefined ? {} : { options: { rootStep: createOptions.rootStep } }),
    })
    return {
      cancel: (id: string) => cancelWorkflow(name, id),
      name,
      defer: async (payload?: TPayload, options: WorkflowStartOptions = {}) => deferWorkflow<TPayload>(
        name,
        payload,
        await resolveWorkflowStartOptions(name, payload, createOptions, options),
      ),
      getRun: (id: string) => getWorkflowRun(name, id),
      async run(payload?: TPayload, options: WorkflowStartOptions = {}) {
        const run = await runWorkflow<TPayload>(name, payload, await resolveWorkflowStartOptions(name, payload, createOptions, options))
        // SAFETY: Typed createWorkflow options require the registered handler that produces TResult.
        return run as WorkflowRun<TPayload, TResult>
      },
    }
  }

  const name = nameOrOptions
  if (!name || !hasRuntimeType(name, "string")) {
    throw new TypeError("`createWorkflow()` requires a workflow name.")
  }

  const handler = hasRuntimeType(handlerOrOptions, "function")
    ? handlerOrOptions
    : hasRuntimeType(handlerOrOptions, "object") && handlerOrOptions !== null
      ? handlerOrOptions.handler
      : undefined
  const createOptions = hasRuntimeType(handlerOrOptions, "function") ? options : handlerOrOptions

  if (handler !== undefined) {
    if (!hasRuntimeType(handler, "function")) {
      throw new TypeError("`createWorkflow()` requires a workflow handler.")
    }
    registerInlineWorkflowDefinition(name, {
      // SAFETY: Workflow definition registration establishes the asserted typed handle contract.
      handler: handler as WorkflowHandler,
      ...(createOptions?.rootStep === undefined ? {} : { options: { rootStep: createOptions.rootStep } }),
    })
  }
  else if (handlerOrOptions !== undefined && (!hasRuntimeType(handlerOrOptions, "object") || handlerOrOptions === null)) {
    throw new TypeError("`createWorkflow()` options must be an object.")
  }

  return {
    cancel: (id: string) => cancelWorkflow(name, id),
    name,
    defer: async (payload?: TPayload, options: WorkflowStartOptions = {}) => deferWorkflow<TPayload>(
      name,
      payload,
      await resolveWorkflowStartOptions(name, payload, createOptions, options),
    ),
    getRun: (id: string) => getWorkflowRun(name, id),
    async run(payload?: TPayload, options: WorkflowStartOptions = {}) {
      const run = await runWorkflow<TPayload>(name, payload, await resolveWorkflowStartOptions(name, payload, createOptions, options))
      // SAFETY: Typed createWorkflow overloads require a handler; handler-free handles expose unknown results.
      return run as WorkflowRun<TPayload, TResult>
    },
  }
}

export async function runWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowDeferOptions = {},
): Promise<WorkflowRun<TPayload, unknown>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  const id = options.id || randomId("wrun")
  const definition = await loadRequiredWorkflowDefinition(name)
  return await getWorkflowRuntimeAdapter(config).run<TPayload, unknown>({
    // SAFETY: The named Workflow definition receives the caller-provided payload and its result remains unknown.
    definition: definition as WorkflowDefinition<TPayload, unknown>,
    event: getWorkflowRuntimeEvent(),
    id,
    name,
    options,
    payload,
  })
}

export async function getWorkflowRun(name: string, id: string): Promise<WorkflowRun<unknown, unknown>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  return await getWorkflowRuntimeAdapter(config).get({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

export async function cancelWorkflow(name: string, id: string): Promise<WorkflowRun<unknown, unknown>> {
  const config = getActiveWorkflowConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
  }

  await loadRequiredWorkflowDefinition(name)
  return await getWorkflowRuntimeAdapter(config).cancel({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

export async function resumeWorkflowSignal<TPayload = unknown>(token: string, payload: TPayload): Promise<WorkflowSignalResult> {
  if (!token || !hasRuntimeType(token, "string")) {
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
