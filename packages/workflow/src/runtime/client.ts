import { resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { randomId } from "@vite-hub/internal/runtime/random"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { normalizeWorkflowOptions } from "../config.ts"
import { createWorkflowError } from "../errors.ts"

import { getWorkflowRuntimeAdapter } from "./adapters.ts"
import { safeWorkflowName } from "./provider-operation.ts"
import { getWorkflowRuntimeConfig, getWorkflowRuntimeEvent, loadWorkflowDefinition, registerInlineWorkflowDefinition, runWithWorkflowRuntimeEvent } from "./state.ts"
import { getWorkflowTestRun, recordWorkflowTestRun } from "./test-client.ts"

import type { ResolvedWorkflowOptions, WorkflowCreateOptions, WorkflowDefinition, WorkflowHandle, WorkflowHandler, WorkflowRun, WorkflowRunIdValue, WorkflowSignalResult, WorkflowStartOptions } from "../types.ts"
import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

function getActiveWorkflowConfig(): ResolvedWorkflowOptions {
  const config = getWorkflowRuntimeConfig()
  if (config === false) {
    throw createWorkflowError({
      code: "WORKFLOW_DISABLED",
    })
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
  // 67 characters, a `-`, and 32 hex digits fit the 100-character Cloudflare instance id.
  const prefix = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 67) || "workflow"
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
  let name: string
  let handler: WorkflowHandler<TPayload, TResult> | undefined
  let createOptions: WorkflowCreateOptions<TPayload, TResult> | undefined

  if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
    createOptions = nameOrOptions
    if (!createOptions.name || typeof createOptions.name !== "string") {
      throw workflowErrorDiagnostics.WORKFLOW_R0009({ message: "`createWorkflow()` requires a workflow name." })
    }
    if (typeof createOptions.handler !== "function") {
      throw workflowErrorDiagnostics.WORKFLOW_R0010({ message: "`createWorkflow()` requires a workflow handler." })
    }
    name = createOptions.name
    handler = createOptions.handler
  }
  else {
    name = nameOrOptions
    if (!name || typeof name !== "string") {
      throw workflowErrorDiagnostics.WORKFLOW_R0011({ message: "`createWorkflow()` requires a workflow name." })
    }
    handler = typeof handlerOrOptions === "function"
      ? handlerOrOptions
      : typeof handlerOrOptions === "object" && handlerOrOptions !== null
        ? handlerOrOptions.handler
        : undefined
    createOptions = typeof handlerOrOptions === "function" ? options : handlerOrOptions
    if (handler !== undefined && typeof handler !== "function") {
      throw workflowErrorDiagnostics.WORKFLOW_R0012({ message: "`createWorkflow()` requires a workflow handler." })
    }
    if (handler === undefined && handlerOrOptions !== undefined && (typeof handlerOrOptions !== "object" || handlerOrOptions === null)) {
      throw workflowErrorDiagnostics.WORKFLOW_R0013({ message: "`createWorkflow()` options must be an object." })
    }
  }

  if (handler !== undefined) {
    registerInlineWorkflowDefinition(name, {
      // SAFETY: Workflow definition registration establishes the handler's erased registry payload contract.
      handler: handler as WorkflowHandler,
      ...(createOptions?.rootStep === undefined ? {} : { options: { rootStep: createOptions.rootStep } }),
    })
  }

  return {
    cancel: (id: string) => cancelWorkflow(name, id),
    name,
    defer: (payload?: TPayload, options: WorkflowStartOptions = {}) => deferWorkflowStart(
      name,
      async () => await startWorkflowRun<TPayload>(name, payload, await resolveWorkflowStartOptions(name, payload, createOptions, options), true),
    ),
    getRun: (id: string) => getWorkflowRun(name, id),
    async start(payload?: TPayload, options: WorkflowStartOptions = {}) {
      const run = await startWorkflow<TPayload>(name, payload, await resolveWorkflowStartOptions(name, payload, createOptions, options))
      // SAFETY: Typed createWorkflow overloads require a handler; handler-free handles expose unknown results.
      return run as WorkflowRun<TPayload, TResult>
    },
  }
}

/** Starts one durable run of a Workflow Definition and returns its id and status. */
export async function startWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowStartOptions = {},
): Promise<WorkflowRun<TPayload, unknown>> {
  return await startWorkflowRun(name, payload, options)
}

async function startWorkflowRun<TPayload>(
  name: string,
  payload: TPayload | undefined,
  options: WorkflowStartOptions,
  deferred = false,
): Promise<WorkflowRun<TPayload, unknown>> {
  const config = getActiveWorkflowConfig()

  const id = options.id || randomId("wrun")
  const definition = await loadRequiredWorkflowDefinition(name)
  if (config.provider === "vercel" && definition.options?.native && options.id) {
    throw createWorkflowError({
      code: "WORKFLOW_RUN_ID_UNSUPPORTED",
      details: { ...(safeWorkflowName(name) ? { name } : {}), provider: "vercel" },
    })
  }
  const test = getViteHubTestMode()
  if (test) return recordWorkflowTestRun(test, config.provider, { deferred, id, name, payload })
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
  const test = getViteHubTestMode()
  if (test) return getWorkflowTestRun(test, config.provider, name, id)

  return await getWorkflowRuntimeAdapter(config).get({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

export async function cancelWorkflow(name: string, id: string): Promise<WorkflowRun<unknown, unknown>> {
  const config = getActiveWorkflowConfig()

  const definition = await loadRequiredWorkflowDefinition(name)
  const test = getViteHubTestMode()
  if (test) {
    if (config.provider === "cloudflare" || (config.provider === "vercel" && !definition.options?.native)) {
      throw createWorkflowError({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "cancellation", provider: config.provider } })
    }
    return getWorkflowTestRun(test, config.provider, name, id, true)
  }
  return await getWorkflowRuntimeAdapter(config).cancel({
    event: getWorkflowRuntimeEvent(),
    id,
    name,
  })
}

/** Resumes a run that waits for a signal. `token` is the opaque token that the provider gave the waiting step. */
export async function resumeWorkflow<TPayload = unknown>(token: string, payload: TPayload): Promise<WorkflowSignalResult> {
  if (!token || typeof token !== "string") {
    throw workflowErrorDiagnostics.WORKFLOW_R0014({ message: "`resumeWorkflow()` requires an opaque signal token." })
  }
  const config = getActiveWorkflowConfig()
  // Test backends start no handlers, so there is no suspended signal to resume.
  if (getViteHubTestMode()) {
    throw createWorkflowError({ code: "WORKFLOW_OPERATION_UNSUPPORTED", details: { operation: "signals", provider: config.provider } })
  }
  return await getWorkflowRuntimeAdapter(config).resume(token, payload)
}

function deferWorkflowStart(name: string, start: () => Promise<unknown>): void {
  const request = getWorkflowRuntimeEvent()
  const promise = runWithWorkflowRuntimeEvent(request, start).then(() => undefined, (error: unknown) => {
    console.error(`[vitehub] Deferred Workflow start failed for "${name}"`, error)
  })
  const waitUntil = resolveWaitUntil(request)
  if (typeof waitUntil === "function") {
    waitUntil(promise)
  }
}

/**
 * Starts a run after the response, through `waitUntil`. It returns nothing: a failure goes to the log.
 * Call `startWorkflow()` when the caller needs the run ID or the start error.
 */
export function deferWorkflow<TPayload = unknown>(
  name: string,
  payload?: TPayload,
  options: WorkflowStartOptions = {},
): void {
  deferWorkflowStart(name, () => startWorkflowRun<TPayload>(name, payload, options, true))
}
