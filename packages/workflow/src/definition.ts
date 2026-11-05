import type { WorkflowDefinition, WorkflowDefinitionOptions, WorkflowHandler } from "./types.ts"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * Defines the Workflow `name`. The name is the folder or file name that ViteHub discovers, and it
 * types `steps` with the step files of that folder. Annotate `payload` to type the payload.
 *
 * ```ts
 * export default defineWorkflow("onboard-user", async (payload: { email: string }, { steps }) => {
 *   const user = await steps.createUser(payload)
 *   return await steps.sendWelcome(user)
 * })
 * ```
 */
export function defineWorkflow<const TName extends string, TPayload = undefined, TResult = unknown>(
  name: TName,
  handler: WorkflowHandler<TPayload, TResult, TName>,
  options?: WorkflowDefinitionOptions<TPayload, TResult>,
): WorkflowDefinition<TPayload, TResult, TName> {
  if (typeof name !== "string" || !name) {
    throw workflowErrorDiagnostics.WORKFLOW_C0018({ message: "`defineWorkflow()` requires the Workflow name as its first argument, for example `defineWorkflow(\"onboard-user\", handler)`." })
  }

  if (typeof handler !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0014({ message: "`defineWorkflow()` requires a workflow handler." })
  }

  if (typeof options !== "undefined" && (!options || typeof options !== "object" || Array.isArray(options))) {
    throw workflowErrorDiagnostics.WORKFLOW_C0015({ message: "`defineWorkflow()` options must be a plain object." })
  }

  if (options?.native !== undefined && typeof options.native !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0016({ message: "`defineWorkflow()` native entry must be a workflow handler." })
  }

  return { handler, name, options }
}

/** Throws when a definition names another Workflow than the one ViteHub discovered at its path. */
export function assertWorkflowDefinitionName(discoveredName: string, definition: { name?: string } | undefined): void {
  if (definition?.name === undefined || definition.name === discoveredName) return
  throw workflowErrorDiagnostics.WORKFLOW_C0019({
    message: `[vitehub] The Workflow at ${JSON.stringify(discoveredName)} calls \`defineWorkflow(${JSON.stringify(definition.name)})\`. Pass ${JSON.stringify(discoveredName)}, the name that ViteHub reads from its folder or file name.`,
  })
}
