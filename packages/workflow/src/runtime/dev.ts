import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText, redactInspectionValue } from "@vite-hub/internal/inspect"

import { resolveWorkflowDevSupport, workflowDevHeader, workflowDevHeaderValue, workflowDevLabel } from "../dev-support.ts"
import { cancelWorkflow, getWorkflowRun, resumeWorkflowSignal, runWorkflow } from "./client.ts"
import { getInlineWorkflowDefinitions, getWorkflowRuntimeConfig, getWorkflowRuntimeRegistry } from "./state.ts"

import type { WorkflowDevOperation, WorkflowDevRequest, WorkflowDevResponseBody, WorkflowDevRunView } from "../dev-support.ts"
import type { WorkflowProvider, WorkflowRun } from "../types.ts"

/**
 * Data that the Vite plugin generates for the development-only Nitro handler.
 */
export interface WorkflowDevRuntimeOptions {
  /** Workflow configuration error in the Vite config. All operations fail with this message. */
  configError?: string
  /** Provider that the Vite config selects, or `null` when Workflow is disabled. */
  configuredProvider: WorkflowProvider | null
}

interface WorkflowDevResult {
  body: WorkflowDevResponseBody
  status: number
}

const maxRequestBytes = 1024 * 1024
const maxRememberedRuns = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function failure(status: number, code: string, message: string): WorkflowDevResult {
  return { body: { error: { code, message } }, status }
}

function respond(result: WorkflowDevResult): Response {
  return Response.json(result.body, { headers: { "cache-control": "no-store" }, status: result.status })
}

function parseRequest(body: unknown): WorkflowDevRequest | undefined {
  if (!isRecord(body)) return
  const operation = body.operation
  if (operation === "start") {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
    if (typeof body.workflow !== "string" || !body.workflow) return
    return { operation, workflow: body.workflow, ...("input" in body ? { input: body.input } : {}) }
  }
  if (operation === "get" || operation === "cancel") {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
    if (typeof body.runId !== "string" || !body.runId) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
    if (body.workflow !== undefined && (typeof body.workflow !== "string" || !body.workflow)) return
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
    return { operation, runId: body.runId, ...(typeof body.workflow === "string" ? { workflow: body.workflow } : {}) }
  }
  if (operation === "resume") {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
    if (typeof body.token !== "string" || !body.token) return
    return { operation, token: body.token, ...("payload" in body ? { payload: body.payload } : {}) }
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error) return serializeError(value)
  if (value instanceof Response) return { response: { status: value.status, statusText: value.statusText } }
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  if (!error || typeof error !== "object") return
  const code = Reflect.get(error, "code")
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  return typeof code === "string" ? code : undefined
}

function serializeError(error: Error): { code?: string, message: string, name?: string } {
  const code = errorCode(error)
  return {
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Error code is optional in the public response.
    ...(code ? { code } : {}),
    message: redactInspectionText(error.message),
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Default Error names are omitted from the response.
    ...(error.name && error.name !== "Error" ? { name: error.name } : {}),
  }
}

function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  return typeof value === "string" ? value : undefined
}

function isErrorLike(value: unknown): value is Error {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Validate opaque request or provider values at the Workflow dev endpoint boundary.
  return value instanceof Error || (isRecord(value) && typeof value.message === "string")
}

// Inline runs store the handler result as a serialized `Response`. Read its body
// so that the CLI shows the value that the Workflow returned.
async function readResult(result: unknown): Promise<unknown> {
  if (!(result instanceof Response)) return result
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
export async function toWorkflowDevRunView(run: WorkflowRun<unknown, unknown>, workflow: string): Promise<WorkflowDevRunView> {
  const createdAt = toIsoDate(run.createdAt)
  const startedAt = toIsoDate(run.startedAt)
  const completedAt = toIsoDate(run.completedAt)
  const error = run.status === "failed" && isErrorLike(run.metadata) ? serializeError(run.metadata) : undefined
  const metadata = error ? undefined : toJsonValue(run.metadata)
  const result = toJsonValue(await readResult(run.result))
  return {
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional run fields are omitted when unavailable.
    ...(completedAt ? { completedAt } : {}),
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional run fields are omitted when unavailable.
    ...(createdAt ? { createdAt } : {}),
    // doctor-disable-next-line typescript/style/no-conditional-empty-object-spread -- Optional run fields are omitted when unavailable.
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

function runtimeFailure(operation: WorkflowDevOperation, provider: WorkflowProvider, error: unknown): WorkflowDevResult {
  const code = errorCode(error)
  if (code === "WORKFLOW_OPERATION_UNSUPPORTED") {
    return failure(501, code, `workflow ${operation} is not supported by the ${provider} provider for this run.`)
  }
  if (code === "WORKFLOW_DISABLED") {
    return failure(409, code, "Workflow is disabled in the Nitro dev runtime.")
  }
  if (code === "WORKFLOW_DEFINITION_NOT_FOUND") {
    return failure(404, code, "Workflow definition was not found.")
  }
  if (code === "VERCEL_WORKFLOW_SDK_LOAD_FAILED" || code === "WORKFLOW_NATIVE_ENTRY_INVALID" || code === "WORKFLOW_NATIVE_ENTRY_REQUIRED") {
    return failure(501, code, `workflow ${operation} needs the Vercel Workflow DevKit runtime, which the Nitro dev runtime could not load.`)
  }
  if (code === "WORKFLOW_PROVIDER_OPERATION_FAILED") {
    // The error message is generic. The cause says what the provider reported.
    const cause = error instanceof Error ? error.cause : undefined
    const reason = cause instanceof Error && cause.message ? ` ${redactInspectionText(cause.message)}` : ""
    return failure(502, code, `workflow ${operation} failed in the ${provider} provider.${reason}`)
  }
  const message = error instanceof Error ? error.message : String(error)
  return failure(500, code || "WORKFLOW_DEV_FAILED", redactInspectionText(message || "Workflow dev request failed."))
}

async function readRequestBody(request: Request): Promise<{ body?: unknown, error?: WorkflowDevResult }> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
    return { error: failure(413, "WORKFLOW_DEV_INVALID_REQUEST", "Workflow Dev request is too large.") }
  }
  try {
    return { body: JSON.parse(text) }
  }
  catch {
    return { error: failure(400, "WORKFLOW_DEV_INVALID_REQUEST", "Malformed Workflow Dev request.") }
  }
}

// Workflows that the app can start by name: the registry that the runtime
// installed, and inline Workflow Definitions that the app registered.
function startableWorkflows(): string[] {
  return [...new Set([...Object.keys(getWorkflowRuntimeRegistry() ?? {}), ...getInlineWorkflowDefinitions().keys()])].sort()
}

/**
 * Creates the request handler of the development-only Nitro route behind
 * `vitehub workflow`.
 *
 * The handler runs in the Nitro dev runtime, so it uses the same Workflow
 * state and registry as the app. It does not change the Workflow
 * configuration or the registry of the runtime. It remembers the Workflow
 * name of each run that it starts, and it redacts credentials in run data and
 * error messages.
 */
export function createWorkflowDevRequestHandler(options: WorkflowDevRuntimeOptions): (request: Request) => Promise<Response> {
  const startedRuns = new Map<string, string>()

  function rememberRun(id: string, workflow: string): void {
    startedRuns.delete(id)
    startedRuns.set(id, workflow)
    if (startedRuns.size > maxRememberedRuns) {
      const oldest = startedRuns.keys().next().value
      if (oldest !== undefined) startedRuns.delete(oldest)
    }
  }

  async function execute(request: WorkflowDevRequest): Promise<WorkflowDevResult> {
    if (options.configError || !options.configuredProvider) {
      const support = resolveWorkflowDevSupport(null, options.configError)[request.operation]
      return failure(409, "WORKFLOW_DEV_UNSUPPORTED", `workflow ${request.operation} is not available. ${support.note}`)
    }
    const runtimeConfig = getWorkflowRuntimeConfig()
    if (runtimeConfig === false) {
      return failure(409, "WORKFLOW_DISABLED", "Workflow is disabled in the Nitro dev runtime.")
    }
    // The runtime uses inline Vercel execution when the app installs no Workflow configuration.
    const provider = runtimeConfig?.provider ?? "vercel"
    const support = resolveWorkflowDevSupport(provider)[request.operation]
    if (!support.supported) {
      return failure(501, "WORKFLOW_DEV_UNSUPPORTED", `workflow ${request.operation} is not supported by the ${provider} provider. ${support.note}`)
    }
    const configNote = provider === options.configuredProvider
      ? ""
      : ` The Vite config selects ${options.configuredProvider}, but the Nitro dev runtime uses ${provider}${runtimeConfig ? "" : " because the app installs no Workflow configuration in development"}.`
    const note = `${support.note}${configNote}`

    try {
      if (request.operation === "start") {
        const workflows = startableWorkflows()
        if (!workflows.includes(request.workflow)) {
          if (!getWorkflowRuntimeRegistry()) {
            return failure(409, "WORKFLOW_DEV_REGISTRY_MISSING", `Unknown Workflow: ${request.workflow}. The Nitro dev runtime has no Workflow registry. The Workflow Vite plugin installs the discovered registry with the Nitro plugin .vitehub/nitro/workflow/dev-plugin.mjs when the dev server starts. Make sure that Nitro loads this plugin, then restart the dev server.`)
          }
          const available = workflows.length ? ` Available Workflows: ${workflows.join(", ")}.` : " The Workflow registry of the Nitro dev runtime is empty."
          return failure(404, "WORKFLOW_DEFINITION_NOT_FOUND", `Unknown Workflow: ${request.workflow}.${available}`)
        }
        const run = await runWorkflow(request.workflow, request.input)
        rememberRun(run.id, request.workflow)
        return { body: { note, run: await toWorkflowDevRunView(run, request.workflow) }, status: 200 }
      }
      if (request.operation === "resume") {
        const signal = await resumeWorkflowSignal(request.token, request.payload)
        return { body: { note, signal: { id: signal.id, provider: signal.provider } }, status: 200 }
      }
      const workflow = request.workflow ?? startedRuns.get(request.runId)
      if (!workflow) {
        return failure(400, "WORKFLOW_DEV_RUN_UNKNOWN", `Run ${request.runId} was not started by \`vitehub workflow start\` in this Nitro dev runtime. Pass --workflow <name>.`)
      }
      const run = request.operation === "get"
        ? await getWorkflowRun(workflow, request.runId)
        : await cancelWorkflow(workflow, request.runId)
      return { body: { note, run: await toWorkflowDevRunView(run, workflow) }, status: 200 }
    }
    catch (error) {
      return runtimeFailure(request.operation, provider, error)
    }
  }

  return async (request) => {
    const { rejection } = await validateViteHubNitroDevRequest(request, { header: workflowDevHeader, headerValue: workflowDevHeaderValue, label: workflowDevLabel })
    if (rejection) return rejection
    try {
      const { body, error } = await readRequestBody(request)
      if (error) return respond(error)
      const parsed = parseRequest(body)
      if (!parsed) return respond(failure(400, "WORKFLOW_DEV_INVALID_REQUEST", "Malformed Workflow Dev request."))
      return respond(await execute(parsed))
    }
    catch (error) {
      return respond(failure(500, "WORKFLOW_DEV_FAILED", redactInspectionText(error instanceof Error ? error.message : String(error))))
    }
  }
}
