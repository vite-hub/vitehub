import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

const workflowErrorMessages = {
  OPENWORKFLOW_BACKEND_CLOSE_FAILED: "OpenWorkflow backend cleanup failed.",
  OPENWORKFLOW_RUNTIME_RESET: "OpenWorkflow runtime was reset while it was being acquired.",
  OPENWORKFLOW_WORKER_STOP_FAILED: "OpenWorkflow worker stop failed.",
  VERCEL_WORKFLOW_SDK_LOAD_FAILED: "Vercel Workflow DevKit load failed. Install the optional workflow peer dependency.",
  WORKFLOW_DEFINITION_NOT_FOUND: "Workflow definition was not found.",
  WORKFLOW_DISABLED: "Workflow is disabled.",
  WORKFLOW_NATIVE_ENTRY_INVALID: "Workflow has no transformed native Vercel entry.",
  WORKFLOW_NATIVE_ENTRY_REQUIRED: "Workflow has no native durable entry for Vercel.",
  WORKFLOW_OPERATION_UNSUPPORTED: "Workflow provider operation is unsupported.",
  WORKFLOW_PROVIDER_OPERATION_FAILED: "Workflow provider operation failed.",
  WORKFLOW_RUN_ID_UNSUPPORTED: "Native Vercel workflows assign their own run IDs.",
} as const

const workflowProviderNames = ["cloudflare", "openworkflow", "vercel"] as const
const workflowOperationNames = [
  "cancel",
  "cancellation",
  "connect",
  "create",
  "get",
  "get-run",
  "import",
  "list-steps",
  "resume-signal",
  "run",
  "signals",
  "start",
  "status",
] as const

export type WorkflowErrorCode = keyof typeof workflowErrorMessages
export type WorkflowOperationName = typeof workflowOperationNames[number]
export type WorkflowProviderName = typeof workflowProviderNames[number]

type WorkflowNameDetails = { name?: string }
type VercelWorkflowDetails = { name?: string, provider: "vercel" }
type WorkflowOperationDetails = { operation: WorkflowOperationName, provider: WorkflowProviderName }
type WorkflowProviderOperationDetails = WorkflowOperationDetails & { status?: number }

export type WorkflowErrorDetails<TCode extends WorkflowErrorCode = WorkflowErrorCode> =
  TCode extends "OPENWORKFLOW_BACKEND_CLOSE_FAILED" | "OPENWORKFLOW_RUNTIME_RESET" | "OPENWORKFLOW_WORKER_STOP_FAILED" ? { provider: "openworkflow" }
    : TCode extends "VERCEL_WORKFLOW_SDK_LOAD_FAILED" ? { provider: "vercel" }
      : TCode extends "WORKFLOW_DEFINITION_NOT_FOUND" ? WorkflowNameDetails
        : TCode extends "WORKFLOW_DISABLED" ? Record<string, never>
          : TCode extends "WORKFLOW_NATIVE_ENTRY_INVALID" | "WORKFLOW_NATIVE_ENTRY_REQUIRED" | "WORKFLOW_RUN_ID_UNSUPPORTED" ? VercelWorkflowDetails
            : TCode extends "WORKFLOW_OPERATION_UNSUPPORTED" ? WorkflowOperationDetails
              : TCode extends "WORKFLOW_PROVIDER_OPERATION_FAILED" ? WorkflowProviderOperationDetails
                : never

export type WorkflowErrorOptions<TCode extends WorkflowErrorCode = WorkflowErrorCode> = ViteHubErrorOptions<WorkflowErrorDetails<TCode>> & {
  code: TCode
  details?: WorkflowErrorDetails<TCode>
}

export function createWorkflowError<TCode extends WorkflowErrorCode>(
  options: WorkflowErrorOptions<TCode>,
): ViteHubError<TCode, WorkflowErrorDetails<TCode>> {
  return new ViteHubError(options.code, workflowErrorMessages[options.code], options)
}
