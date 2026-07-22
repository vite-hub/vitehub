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
  if (typeof error !== "object" || error === null) return false

  try {
    return "name" in error && error.name === "AbortError"
  }
  catch {
    return false
  }
}

function getProviderStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined

  try {
    const value = error as { response?: unknown, status?: unknown, statusCode?: unknown }
    const response = typeof value.response === "object" && value.response !== null
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

export async function runWorkflowProviderOperation<T>(
  provider: WorkflowProvider,
  operation: WorkflowProviderOperation,
  run: () => T | PromiseLike<T>,
): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    if (isWorkflowBoundaryError(error)) throw error

    const status = getProviderStatus(error)
    throw createWorkflowError({
      cause: error,
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { operation, provider, ...(status === undefined ? {} : { status }) },
    })
  }
}

export function safeWorkflowName(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : undefined
}
