import type { WorkflowDefinition, WorkflowDefinitionOptions, WorkflowHandler } from "./types.ts"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

export function defineWorkflow<TPayload = unknown, TResult = unknown>(
  handler: WorkflowHandler<TPayload, TResult>,
  options?: WorkflowDefinitionOptions<TPayload, TResult>,
): WorkflowDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0014({ message: "`defineWorkflow()` requires a workflow handler." })
  }

  if (typeof options !== "undefined" && (!options || typeof options !== "object" || Array.isArray(options))) {
    throw workflowErrorDiagnostics.WORKFLOW_C0015({ message: "`defineWorkflow()` options must be a plain object." })
  }

  if (options?.native !== undefined && typeof options.native !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0016({ message: "`defineWorkflow()` native entry must be a workflow handler." })
  }

  return { handler, options }
}
