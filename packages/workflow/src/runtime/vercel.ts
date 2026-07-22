import { createWorkflowError } from "../errors.ts"

import { isWorkflowBoundaryError, runWorkflowProviderOperation, safeWorkflowName } from "./provider-operation.ts"

import type { WorkflowDefinition, WorkflowExecutionContext, WorkflowRun, WorkflowRunStatus, WorkflowRunStep, WorkflowSignalResult } from "../types.ts"

export interface VercelRun {
  cancel: () => Promise<void>
  completedAt: Promise<Date | undefined>
  createdAt: Promise<Date>
  exists: Promise<boolean>
  returnValue: Promise<unknown>
  runId: string
  startedAt: Promise<Date | undefined>
  status: Promise<string>
  workflowName: Promise<string>
}

export interface VercelStep {
  attempt: number
  completedAt?: Date
  error?: unknown
  startedAt?: Date
  status: string
  stepId: string
  stepName: string
}

export interface VercelWorkflowRuntime {
  getRun: (id: string) => VercelRun
  listSteps: (id: string) => Promise<VercelStep[]>
  resumeHook: (token: string, payload: unknown) => Promise<{ runId: string }>
  start: (handler: (...args: never[]) => unknown, args: unknown[]) => Promise<VercelRun>
}

interface VercelWorkflowApiModule {
  getRun: (id: string) => VercelRun
  resumeHook: VercelWorkflowRuntime["resumeHook"]
  start: VercelWorkflowRuntime["start"]
}

interface VercelWorkflowRuntimeModule {
  getWorld: () => Promise<{
    steps: {
      list: (options: unknown) => Promise<{ cursor?: string, data: unknown[], hasMore: boolean }>
    }
  }> | {
    steps: {
      list: (options: unknown) => Promise<{ cursor?: string, data: unknown[], hasMore: boolean }>
    }
  }
}

async function loadVercelWorkflowRuntime(): Promise<VercelWorkflowRuntime> {
  const importVercelWorkflow = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>
  const [api, runtime] = await Promise.all([
    importVercelWorkflow<VercelWorkflowApiModule>("workflow/api"),
    importVercelWorkflow<VercelWorkflowRuntimeModule>("workflow/runtime"),
  ])
  return createVercelWorkflowRuntime(api, runtime)
}

function createVercelWorkflowRuntime(api: VercelWorkflowApiModule, runtime: VercelWorkflowRuntimeModule): VercelWorkflowRuntime {
  const { getRun, resumeHook, start } = api
  const { getWorld } = runtime
  return {
    getRun: getRun as (id: string) => VercelRun,
    async listSteps(id) {
      const steps: VercelStep[] = []
      let cursor: string | undefined
      do {
        const page = await (await getWorld()).steps.list({
          pagination: { cursor, limit: 1000, sortOrder: "asc" },
          resolveData: "none",
          runId: id,
        })
        steps.push(...(page.data as VercelStep[]))
        cursor = page.hasMore && page.cursor ? page.cursor : undefined
      } while (cursor)
      return steps
    },
    resumeHook,
    start: start as VercelWorkflowRuntime["start"],
  }
}

let runtimeLoader: () => Promise<VercelWorkflowRuntime> = loadVercelWorkflowRuntime

export function setVercelWorkflowRuntimeLoader(loader?: () => Promise<VercelWorkflowRuntime>): void {
  runtimeLoader = loader || loadVercelWorkflowRuntime
}

export function setVercelWorkflowRuntimeModules(api: VercelWorkflowApiModule, runtime: VercelWorkflowRuntimeModule): void {
  runtimeLoader = async () => createVercelWorkflowRuntime(api, runtime)
}

async function getVercelWorkflowRuntime(): Promise<VercelWorkflowRuntime> {
  try {
    return await runtimeLoader()
  }
  catch (error) {
    if (isWorkflowBoundaryError(error)) throw error

    throw createWorkflowError({
      cause: error,
      code: "VERCEL_WORKFLOW_SDK_LOAD_FAILED",
      details: { provider: "vercel" },
    })
  }
}

const statusMap: Record<string, WorkflowRunStatus> = {
  cancelled: "cancelled",
  completed: "completed",
  failed: "failed",
  pending: "queued",
  running: "running",
}

function invalidVercelResult(field: string): TypeError {
  return new TypeError(`Vercel Workflow provider returned an invalid ${field}.`)
}

function normalizeStatus(status: unknown): WorkflowRunStatus {
  if (typeof status !== "string") throw invalidVercelResult("status")
  return statusMap[status.toLowerCase()] || "unknown"
}

function normalizeRunId(id: unknown): string {
  if (typeof id !== "string" || !id) throw invalidVercelResult("run ID")
  return id
}

function normalizeDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw invalidVercelResult(field)
  return value
}

function normalizeStepError(error: unknown): { code?: string; message: string } | undefined {
  if (error === undefined || error === null) return undefined
  if (error instanceof Error) return { message: error.message }
  if (typeof error === "string") {
    try {
      return normalizeStepError(JSON.parse(error)) || { message: error }
    }
    catch {
      return { message: error }
    }
  }
  if (typeof error === "object") {
    const value = error as { code?: unknown, error?: unknown, message?: unknown }
    if (typeof value.message === "string") {
      return {
        ...(typeof value.code === "string" ? { code: value.code } : {}),
        message: value.message,
      }
    }
    if (value.error !== undefined) return normalizeStepError(value.error)
  }
  return { message: "Workflow step failed." }
}

function normalizeSteps(steps: unknown): WorkflowRunStep[] {
  if (!Array.isArray(steps)) throw invalidVercelResult("step list")

  return steps.map((step) => {
    if (typeof step !== "object" || step === null) throw invalidVercelResult("step")
    const value = step as Partial<VercelStep>
    if (typeof value.attempt !== "number" || !Number.isFinite(value.attempt)) throw invalidVercelResult("step attempt")
    if (typeof value.stepId !== "string" || !value.stepId) throw invalidVercelResult("step ID")
    if (typeof value.stepName !== "string" || !value.stepName) throw invalidVercelResult("step name")

    return {
      attempt: value.attempt,
      completedAt: normalizeDate(value.completedAt, "step completion date"),
      error: normalizeStepError(value.error),
      id: value.stepId,
      name: value.stepName,
      startedAt: normalizeDate(value.startedAt, "step start date"),
      status: normalizeStatus(value.status),
    }
  })
}

async function readRunIdentity(run: VercelRun): Promise<{ exists: false } | { exists: true, workflowName: string }> {
  const exists = await run.exists
  if (typeof exists !== "boolean") throw invalidVercelResult("existence state")
  if (!exists) return { exists }
  const workflowName = await run.workflowName
  if (typeof workflowName !== "string") throw invalidVercelResult("workflow name")
  return { exists, workflowName }
}

function getNativeWorkflowName<TPayload, TResult>(name: string, definition: WorkflowDefinition<TPayload, TResult>): string {
  const workflowName = (definition.options?.native as WorkflowDefinition<TPayload, TResult>["handler"] & { workflowId?: string } | undefined)?.workflowId
  if (!workflowName) {
    throw createWorkflowError({
      code: "WORKFLOW_NATIVE_ENTRY_INVALID",
      details: { ...(safeWorkflowName(name) ? { name } : {}), provider: "vercel" },
    })
  }
  return workflowName
}

export async function inspectVercelWorkflowRun<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, id: string, payload?: TPayload): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getVercelWorkflowRuntime()
  const run = await runWorkflowProviderOperation("vercel", "get-run", () => runtime.getRun(id))
  const identity = await runWorkflowProviderOperation("vercel", "get-run", () => readRunIdentity(run))
  if (!identity.exists || identity.workflowName !== getNativeWorkflowName(name, definition)) {
    return { id, provider: "vercel", status: "unknown" }
  }

  const [snapshot, steps] = await Promise.all([
    runWorkflowProviderOperation("vercel", "get-run", async () => {
      const [status, createdAt, startedAt, completedAt] = await Promise.all([
        run.status,
        run.createdAt,
        run.startedAt,
        run.completedAt,
      ])
      return {
        completedAt: normalizeDate(completedAt, "completion date"),
        createdAt: normalizeDate(createdAt, "creation date"),
        startedAt: normalizeDate(startedAt, "start date"),
        status: normalizeStatus(status),
      }
    }),
    runWorkflowProviderOperation("vercel", "list-steps", async () => normalizeSteps(await runtime.listSteps(id))),
  ])
  const result = snapshot.status === "completed"
    ? await runWorkflowProviderOperation("vercel", "get-run", () => run.returnValue) as TResult
    : undefined
  return {
    completedAt: snapshot.completedAt,
    createdAt: snapshot.createdAt,
    id,
    metadata: { workflow: name },
    payload,
    provider: "vercel",
    result,
    startedAt: snapshot.startedAt,
    status: snapshot.status,
    steps,
  }
}

export async function startVercelWorkflow<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, payload?: TPayload): Promise<WorkflowRun<TPayload, TResult>> {
  const native = definition.options?.native
  if (!native) {
    throw createWorkflowError({
      code: "WORKFLOW_NATIVE_ENTRY_REQUIRED",
      details: { ...(safeWorkflowName(name) ? { name } : {}), provider: "vercel" },
    })
  }
  const context: WorkflowExecutionContext<TPayload> = {
    name,
    payload: payload as TPayload,
    provider: "vercel",
  }
  const runtime = await getVercelWorkflowRuntime()
  const id = await runWorkflowProviderOperation("vercel", "start", async () => {
    const run = await runtime.start(native as never, [context])
    return normalizeRunId(run.runId)
  })
  return {
    id,
    metadata: { workflow: name },
    payload,
    provider: "vercel",
    status: "queued",
  }
}

export async function cancelVercelWorkflow<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, id: string): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getVercelWorkflowRuntime()
  const run = await runWorkflowProviderOperation("vercel", "get-run", () => runtime.getRun(id))
  const identity = await runWorkflowProviderOperation("vercel", "get-run", () => readRunIdentity(run))
  if (!identity.exists || identity.workflowName !== getNativeWorkflowName(name, definition)) {
    return { id, provider: "vercel", status: "unknown" }
  }
  await runWorkflowProviderOperation("vercel", "cancel", () => run.cancel())
  return await inspectVercelWorkflowRun<TPayload, TResult>(name, definition, id)
}

export async function resumeVercelWorkflowSignal(token: string, payload: unknown): Promise<WorkflowSignalResult> {
  const runtime = await getVercelWorkflowRuntime()
  const id = await runWorkflowProviderOperation("vercel", "resume-signal", async () => {
    const hook = await runtime.resumeHook(token, payload)
    return normalizeRunId(hook.runId)
  })
  return { id, provider: "vercel" }
}
