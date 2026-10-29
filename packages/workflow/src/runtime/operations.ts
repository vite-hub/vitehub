import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"

import { resolveWorkflowOperationSupport } from "../results.ts"
import { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "./client.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry } from "./state.ts"

import type { WorkflowOperationName, WorkflowRunResult, WorkflowRunView, WorkflowSignalResult } from "../results.ts"
import type { WorkflowRun } from "../types.ts"

export type { WorkflowRunResult, WorkflowRunView, WorkflowSignalResult }

const maxRememberedRuns = 1024

/** A failure of a Workflow operation, with the status and code that every surface reports. */
export class WorkflowOperationError extends Error {
  readonly code: string
  readonly fix?: string
  readonly status: number

  constructor(message: string, status: number, code: string, fix?: string) {
    super(message)
    this.name = "WorkflowOperationError"
    this.code = code
    this.status = status
    if (fix) this.fix = fix
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isResponse(value: unknown): value is Response {
  if (value instanceof Response) return true
  const statusGetter = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get
  if (!statusGetter) return false
  try {
    statusGetter.call(value)
    return true
  }
  catch {
    return false
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error) return serializeError(value)
  if (isResponse(value)) return { response: { status: value.status, statusText: value.statusText } }
  return value
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const text = JSON.stringify(value, jsonReplacer)
    return text === undefined ? undefined : redactInspectionValue(JSON.parse(text))
  }
  catch {
    return "[unserializable]"
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return
  const code = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}

function serializeError(error: Error): { code?: string, message: string, name?: string } {
  const code = errorCode(error)
  return {
    ...(code ? { code } : {}),
    message: redactInspectionText(error.message),
    ...(error.name && error.name !== "Error" ? { name: error.name } : {}),
  }
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  return typeof value === "string" ? value : undefined
}

function isErrorLike(value: unknown): value is Error {
  return value instanceof Error || (isRecord(value) && typeof value.message === "string")
}

// Inline runs store the handler result as a serialized `Response`. Read its body
// so that the CLI shows the value that the Workflow returned.
async function readResult(result: unknown): Promise<unknown> {
  if (!isResponse(result)) return result
  const text = await result.clone().text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/**
 * Converts a runtime Workflow run to JSON data. The view omits the start
 * payload and redacts credentials in the metadata, result, and error message.
 */
export async function toWorkflowRunView(run: WorkflowRun<unknown, unknown>, workflow: string): Promise<WorkflowRunView> {
  const createdAt = toIsoDate(run.createdAt)
  const startedAt = toIsoDate(run.startedAt)
  const completedAt = toIsoDate(run.completedAt)
  const error = run.status === "failed" && isErrorLike(run.metadata) ? serializeError(run.metadata) : undefined
  const metadata = error ? undefined : toJsonValue(run.metadata)
  const result = toJsonValue(await readResult(run.result))
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(error ? { error } : {}),
    id: run.id,
    ...(metadata === undefined ? {} : { metadata }),
    provider: run.provider,
    ...(result === undefined ? {} : { result }),
    ...(startedAt ? { startedAt } : {}),
    status: run.status,
    workflow,
  }
}

function runtimeFailure(operation: WorkflowOperationName, provider: string, error: unknown): WorkflowOperationError {
  if (error instanceof WorkflowOperationError) return error
  const code = errorCode(error)
  if (code === "WORKFLOW_OPERATION_UNSUPPORTED") {
    return new WorkflowOperationError(`workflow ${operation} is not supported by the ${provider} provider for this run.`, 501, code)
  }
  if (code === "WORKFLOW_DISABLED") {
    return new WorkflowOperationError("Workflow is disabled in this runtime.", 409, code, "Enable Workflow with `vitehub({ workflow: true })` or `hubWorkflow()`.")
  }
  if (code === "WORKFLOW_DEFINITION_NOT_FOUND") {
    return new WorkflowOperationError("Workflow definition was not found.", 404, code)
  }
  if (code === "VERCEL_WORKFLOW_SDK_LOAD_FAILED" || code === "WORKFLOW_NATIVE_ENTRY_INVALID" || code === "WORKFLOW_NATIVE_ENTRY_REQUIRED") {
    return new WorkflowOperationError(`workflow ${operation} needs the Vercel Workflow DevKit runtime, which the runtime could not load.`, 501, code)
  }
  if (code === "WORKFLOW_PROVIDER_OPERATION_FAILED") {
    // The error message is generic. The cause says what the provider reported.
    const cause = error instanceof Error ? error.cause : undefined
    const reason = cause instanceof Error && cause.message ? ` ${redactInspectionText(cause.message)}` : ""
    return new WorkflowOperationError(`workflow ${operation} failed in the ${provider} provider.${reason}`, 502, code)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new WorkflowOperationError(redactInspectionText(message || "The Workflow operation failed."), 500, code || "WORKFLOW_OPERATION_FAILED")
}

// Workflows that the app can start by name: the registry that the runtime
// installed, and inline Workflow Definitions that the app registered.
function startableWorkflows(): string[] {
  return [...new Set([...Object.keys(getWorkflowRuntimeRegistry() ?? {}), ...getInlineWorkflowDefinitions().keys()])].sort()
}

// The runtime remembers the name of each run that it starts, so `get` and `cancel` need no `workflow`.
const startedRuns = new Map<string, string>()

function rememberRun(id: string, workflow: string): void {
  startedRuns.delete(id)
  startedRuns.set(id, workflow)
  if (startedRuns.size > maxRememberedRuns) {
    const oldest = startedRuns.keys().next().value
    if (oldest !== undefined) startedRuns.delete(oldest)
  }
}

export interface WorkflowOperationInputs {
  cancel: { runId: string, workflow?: string }
  get: { runId: string, workflow?: string }
  resume: { payload?: unknown, token: string }
  start: { payload?: unknown, workflow: string }
}

export interface WorkflowOperationResults {
  cancel: WorkflowRunResult
  get: WorkflowRunResult
  resume: WorkflowSignalResult
  start: WorkflowRunResult
}

/**
 * Runs one Workflow operation in the runtime of the app, so it uses the same Workflow state and registry as the app.
 * It redacts credentials in run data and error messages. Failures are `WorkflowOperationError`s.
 */
export async function runWorkflowOperation<Name extends WorkflowOperationName>(operation: Name, input: WorkflowOperationInputs[Name]): Promise<WorkflowOperationResults[Name]> {
  const runtimeConfig = getWorkflowRuntimeConfig()
  if (runtimeConfig === false) {
    throw new WorkflowOperationError("Workflow is disabled in this runtime.", 409, "WORKFLOW_DISABLED", "Enable Workflow with `vitehub({ workflow: true })` or `hubWorkflow()`.")
  }
  // The runtime uses inline Vercel execution when the app installs no Workflow configuration.
  const provider = runtimeConfig?.provider ?? "vercel"
  const support = resolveWorkflowOperationSupport(provider)[operation]
  if (!support.supported) {
    throw new WorkflowOperationError(`workflow ${operation} is not supported by the ${provider} provider. ${support.note}`, 501, "WORKFLOW_OPERATION_UNSUPPORTED")
  }
  try {
    // SAFETY: Each branch narrows the generic `Name` by hand, so the result type is the one of the branch.
    return await run(operation, input) as WorkflowOperationResults[Name]
  }
  catch (error) {
    throw runtimeFailure(operation, provider, error)
  }
}

async function run(operation: WorkflowOperationName, input: WorkflowOperationInputs[WorkflowOperationName]): Promise<WorkflowRunResult | WorkflowSignalResult> {
  if (operation === "start") {
    const { payload, workflow } = input as WorkflowOperationInputs["start"]
    const workflows = startableWorkflows()
    if (!workflows.includes(workflow)) {
      if (!getWorkflowRuntimeRegistry()) {
        throw new WorkflowOperationError(`Unknown Workflow: ${workflow}. The runtime has no Workflow registry.`, 409, "WORKFLOW_REGISTRY_MISSING", "Restart the dev server. In development the Workflow Vite plugin installs the registry with the Nitro plugin .vitehub/nitro/workflow/dev-plugin.mjs.")
      }
      const available = workflows.length ? ` Available Workflows: ${workflows.join(", ")}.` : " The Workflow registry of the runtime is empty."
      throw new WorkflowOperationError(`Unknown Workflow: ${workflow}.${available}`, 404, "WORKFLOW_DEFINITION_NOT_FOUND")
    }
    const started = await runWorkflow(workflow, payload)
    rememberRun(started.id, workflow)
    return { run: await toWorkflowRunView(started, workflow) }
  }
  if (operation === "resume") {
    const { payload, token } = input as WorkflowOperationInputs["resume"]
    const signal = await resumeWorkflowSignal(token, payload)
    return { signal: { id: signal.id, provider: signal.provider } }
  }
  const { runId, workflow: named } = input as WorkflowOperationInputs["get"]
  const workflow = named ?? startedRuns.get(runId)
  if (!workflow) {
    throw new WorkflowOperationError(`Run ${runId} was not started by \`workflow.start\` in this runtime.`, 400, "WORKFLOW_RUN_UNKNOWN", "Pass the name of the Workflow with `--workflow <name>`.")
  }
  const found = operation === "get" ? await getWorkflowRun(workflow, runId) : await cancelWorkflow(workflow, runId)
  return { run: await toWorkflowRunView(found, workflow) }
}
