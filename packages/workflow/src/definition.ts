import { isRecord } from "@vite-hub/internal/object"

import type { WorkflowDefinition } from "./types.ts"
import { workflowErrorDiagnostics } from "./error-diagnostics.ts"

const workflowDefinitionKeys: ReadonlySet<string> = new Set(["handler", "native", "rootStep"])

/**
 * Defines a Workflow from one object: `defineWorkflow({ handler, ...options })`. The file path is the Workflow name.
 * The handler receives one object, `{ payload, steps, sleep, ...context }`. Pass the payload type as the type argument.
 * It types `startWorkflow()` for this Workflow.
 *
 * ```ts
 * export default defineWorkflow<{ email: string }>({
 *   handler: async ({ payload, steps }) => {
 *     const user = await steps.createUser(payload)
 *     return await steps.sendWelcome(user)
 *   },
 * })
 * ```
 */
export function defineWorkflow<TPayload = undefined, TResult = unknown>(definition: WorkflowDefinition<TPayload, TResult>, ...removed: unknown[]): WorkflowDefinition<TPayload, TResult> {
  if (typeof definition === "string" || typeof definition === "function" || removed.length) {
    throw workflowErrorDiagnostics.WORKFLOW_C0015({ message: "`defineWorkflow(name, handler, options)` was removed. The file path is the Workflow name. Pass one object: `defineWorkflow({ handler, ...options })`." })
  }

  if (!isRecord(definition)) {
    throw workflowErrorDiagnostics.WORKFLOW_C0015({ message: "`defineWorkflow()` expects one object with `handler`." })
  }

  const unknownKey = Object.keys(definition).find(key => !workflowDefinitionKeys.has(key))
  if (unknownKey) {
    throw workflowErrorDiagnostics.WORKFLOW_C0015({ message: `\`defineWorkflow()\` does not support the ${JSON.stringify(unknownKey)} option.` })
  }

  if (typeof definition.handler !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0014({ message: "`defineWorkflow()` requires a workflow handler." })
  }

  if (definition.native !== undefined && typeof definition.native !== "function") {
    throw workflowErrorDiagnostics.WORKFLOW_C0016({ message: "`defineWorkflow()` native entry must be a workflow handler." })
  }

  return definition
}
