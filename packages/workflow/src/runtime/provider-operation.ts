import { getViteHubErrorShape } from "@vite-hub/runtime"
import { createWorkflowError } from "../errors.ts"

type WorkflowProvider = "cloudflare" | "openworkflow" | "vercel"

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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider failures cross an untyped runtime boundary before their shape can be inspected.
  if (typeof error !== "object" || error === null) return false

  try {
    return "name" in error && error.name === "AbortError"
  }
  catch {
    return false
  }
}

export function getWorkflowProviderStatus(error: unknown): number | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Provider failures cross an untyped runtime boundary before their status can be inspected.
  if (typeof error !== "object" || error === null) return undefined

  try {
    // SAFETY: The object guard above permits reading only optional unknown status fields.
    const value = error as { response?: unknown, status?: unknown, statusCode?: unknown }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A provider response is untyped until this boundary validates its object representation.
    const response = typeof value.response === "object" && value.response !== null
      // SAFETY: The response object guard above permits reading only its optional unknown status field.
      ? value.response as { status?: unknown }
      : undefined
    const status = value.status ?? value.statusCode ?? response?.status
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Runtime status validation must reject non-number provider values.
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined
  }
  catch {
    return undefined
  }
}

export async function runWorkflowProviderOperation<T>(
  provider: WorkflowProvider,
  operation: WorkflowProviderOperation,
  run: () => T | PromiseLike<T>,
  options: {
    acknowledgementUnknown?: (error: unknown, status: number | undefined) => boolean
    boundaryError?: (error: unknown) => boolean
  } = {},
): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (options.boundaryError?.(error) || isWorkflowBoundaryError(error)) throw error

    const status = getWorkflowProviderStatus(error)
    const acknowledgement = options.acknowledgementUnknown?.(error, status) === true ? "unknown" : undefined
    const details: { acknowledgement?: "unknown", operation: WorkflowProviderOperation, provider: WorkflowProvider, status?: number } = {
      operation,
      provider,
    }
    if (acknowledgement) details.acknowledgement = acknowledgement
    if (status !== undefined) details.status = status
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
