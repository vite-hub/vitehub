import { redactInspectionText } from "@vite-hub/internal/inspect"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { createWorkflowError } from "../errors.ts"
import { getWorkflowDevRecorder } from "./dev-recorder.ts"

import type { WorkflowProviderAcknowledgement } from "../errors.ts"

type WorkflowDriver = "cloudflare" | "openworkflow" | "vercel"

type WorkflowProviderOperation =
  | "cancel"
  | "connect"
  | "create"
  | "get"
  | "get-run"
  | "import"
  | "list-steps"
  | "resume-signal"
  | "run"
  | "start"
  | "status"

export function isWorkflowBoundaryError(error: unknown): boolean {
  if (getViteHubErrorShape(error)) return true
  if (typeof error !== "object" || error === null) return false

  try {
    return "name" in error && error.name === "AbortError"
  }
  catch {
    return false
  }
}

export function getWorkflowProviderStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined

  try {
    // SAFETY: The object guard above permits reading only optional unknown status fields.
    const value = error as { response?: unknown, status?: unknown, statusCode?: unknown }
    const response = typeof value.response === "object" && value.response !== null
      // SAFETY: The response object guard above permits reading only its optional unknown status field.
      ? value.response as { status?: unknown }
      : undefined
    const status = value.status ?? value.statusCode ?? response?.status
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined
  }
  catch {
    return undefined
  }
}

const maxReasonLength = 200

/**
 * A short reason that is safe to send to clients: the provider error name and the first line of its message. URLs,
 * file paths, and credentials are removed, and long opaque values (ids, tokens) are replaced.
 */
export function getWorkflowProviderReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  let name: unknown
  let message: unknown
  try {
    name = Reflect.get(error, "name")
    message = Reflect.get(error, "message")
  }
  catch {
    return undefined
  }
  const firstLine = typeof message === "string" ? message.split(/\r?\n/, 1)[0]!.trim() : ""
  const safeName = typeof name === "string" && /^[A-Za-z][\w$]{0,63}$/.test(name) ? name : undefined
  if (!firstLine) return safeName
  const text = redactInspectionText(firstLine)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/(?:\b[A-Za-z]:)?(?:[\\/][\w.@~+-]+){2,}[\\/]?/g, "[path]")
    .replace(/[\w+/=-]{32,}/g, "[redacted]")
  const reason = safeName ? `${safeName}: ${text}` : text
  return reason.length > maxReasonLength ? `${reason.slice(0, maxReasonLength - 1)}…` : reason
}

function isDevelopment(): boolean {
  return Boolean(getWorkflowDevRecorder()) || globalThis.process?.env?.NODE_ENV === "development"
}

export async function runWorkflowProviderOperation<T>(
  provider: WorkflowDriver,
  operation: WorkflowProviderOperation,
  run: () => T | PromiseLike<T>,
  options: {
    /**
     * Whether the provider got the call. `rejected`: the provider answered and refused it, so nothing changed.
     * `unknown`: the call can have reached the provider. `undefined`: not known to matter for this operation.
     */
    acknowledgement?: (error: unknown, status: number | undefined) => WorkflowProviderAcknowledgement | undefined
    boundaryError?: (error: unknown) => boolean
  } = {},
): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (options.boundaryError?.(error) || isWorkflowBoundaryError(error)) throw error

    const status = getWorkflowProviderStatus(error)
    const acknowledgement = options.acknowledgement?.(error, status)
    const reason = getWorkflowProviderReason(error)
    const details: {
      acknowledgement?: WorkflowProviderAcknowledgement
      operation: WorkflowProviderOperation
      provider: WorkflowDriver
      reason?: string
      status?: number
    } = {
      operation,
      provider,
    }
    if (acknowledgement) details.acknowledgement = acknowledgement
    if (reason) details.reason = reason
    if (status !== undefined) details.status = status
    if (isDevelopment()) console.error(`[vitehub:workflow] Workflow ${operation} failed in the ${provider} provider.`, error)
    throw createWorkflowError({
      cause: error,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details,
    })
  }
}

export function safeWorkflowName(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : undefined
}
