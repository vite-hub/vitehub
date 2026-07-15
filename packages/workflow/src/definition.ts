import type { WorkflowDefinition, WorkflowDefinitionOptions, WorkflowHandler } from "./types.ts"

export function defineWorkflow<TPayload = unknown, TResult = unknown>(
  handler: WorkflowHandler<TPayload, TResult>,
  options?: WorkflowDefinitionOptions<TPayload, TResult>,
): WorkflowDefinition<TPayload, TResult> {
  if (typeof handler !== "function") {
    throw new TypeError("`defineWorkflow()` requires a workflow handler.")
  }

  if (typeof options !== "undefined" && (!options || typeof options !== "object" || Array.isArray(options))) {
    throw new TypeError("`defineWorkflow()` options must be a plain object.")
  }

  if (options?.native !== undefined && typeof options.native !== "function") {
    throw new TypeError("`defineWorkflow()` native entry must be a workflow handler.")
  }

  return { handler, options }
}
