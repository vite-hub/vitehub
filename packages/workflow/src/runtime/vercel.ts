import { WorkflowError } from "../errors.ts"

import type { WorkflowDefinition, WorkflowExecutionContext, WorkflowRun, WorkflowRunStatus, WorkflowSignalResult } from "../types.ts"

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

type VercelWorkflowImporter = <T>(specifier: string) => Promise<T>

async function loadVercelWorkflowRuntime(): Promise<VercelWorkflowRuntime> {
  const importVercelWorkflow = new Function("specifier", "return import(specifier)") as VercelWorkflowImporter
  const [api, runtime] = await Promise.all([
    importVercelWorkflow<VercelWorkflowApiModule>("workflow/api"),
    importVercelWorkflow<VercelWorkflowRuntimeModule>("workflow/runtime"),
  ])
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

async function getVercelWorkflowRuntime(): Promise<VercelWorkflowRuntime> {
  try {
    return await runtimeLoader()
  }
  catch (error) {
    throw new WorkflowError(`Vercel Workflow DevKit load failed. Install the optional workflow peer dependency. Original error: ${error instanceof Error ? error.message : error}`, {
      cause: error,
      code: "VERCEL_WORKFLOW_SDK_LOAD_FAILED",
      provider: "vercel",
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

function normalizeStatus(status: string): WorkflowRunStatus {
  return statusMap[status.toLowerCase()] || "unknown"
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

function getNativeWorkflowName<TPayload, TResult>(name: string, definition: WorkflowDefinition<TPayload, TResult>): string {
  const workflowName = (definition.options?.native as WorkflowDefinition<TPayload, TResult>["handler"] & { workflowId?: string } | undefined)?.workflowId
  if (!workflowName) {
    throw new WorkflowError(`Workflow ${JSON.stringify(name)} has no transformed native Vercel entry.`, {
      code: "WORKFLOW_NATIVE_ENTRY_INVALID",
      details: { name },
      provider: "vercel",
    })
  }
  return workflowName
}

export async function inspectVercelWorkflowRun<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, id: string, payload?: TPayload): Promise<WorkflowRun<TPayload, TResult>> {
  const runtime = await getVercelWorkflowRuntime()
  const run = runtime.getRun(id)
  if (!(await run.exists) || await run.workflowName !== getNativeWorkflowName(name, definition)) {
    return { id, provider: "vercel", status: "unknown" }
  }

  const status = normalizeStatus(await run.status)
  const [createdAt, startedAt, completedAt, steps] = await Promise.all([run.createdAt, run.startedAt, run.completedAt, runtime.listSteps(id)])
  const result = status === "completed" ? ((await run.returnValue) as TResult) : undefined
  return {
    completedAt,
    createdAt,
    id,
    metadata: { workflow: name },
    payload,
    provider: "vercel",
    result,
    startedAt,
    status,
    steps: steps.map(step => ({
      attempt: step.attempt,
      completedAt: step.completedAt,
      error: normalizeStepError(step.error),
      id: step.stepId,
      name: step.stepName,
      startedAt: step.startedAt,
      status: normalizeStatus(step.status),
    })),
  }
}

export async function startVercelWorkflow<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, payload?: TPayload): Promise<WorkflowRun<TPayload, TResult>> {
  const native = definition.options?.native
  if (!native) {
    throw new WorkflowError(`Workflow ${JSON.stringify(name)} has no native durable entry for Vercel.`, {
      code: "WORKFLOW_NATIVE_ENTRY_REQUIRED",
      details: { name },
      provider: "vercel",
    })
  }
  const context: WorkflowExecutionContext<TPayload> = {
    name,
    payload: payload as TPayload,
    provider: "vercel",
  }
  const run = await (await getVercelWorkflowRuntime()).start(native as never, [context])
  return {
    id: run.runId,
    metadata: { workflow: name },
    payload,
    provider: "vercel",
    status: "queued",
  }
}

export async function cancelVercelWorkflow<TPayload = unknown, TResult = unknown>(name: string, definition: WorkflowDefinition<TPayload, TResult>, id: string): Promise<WorkflowRun<TPayload, TResult>> {
  const run = (await getVercelWorkflowRuntime()).getRun(id)
  if (!(await run.exists) || await run.workflowName !== getNativeWorkflowName(name, definition)) {
    return { id, provider: "vercel", status: "unknown" }
  }
  await run.cancel()
  return await inspectVercelWorkflowRun<TPayload, TResult>(name, definition, id)
}

export async function resumeVercelWorkflowSignal(token: string, payload: unknown): Promise<WorkflowSignalResult> {
  const hook = await (await getVercelWorkflowRuntime()).resumeHook(token, payload)
  return { id: hook.runId, provider: "vercel" }
}
