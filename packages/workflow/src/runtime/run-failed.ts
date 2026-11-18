import { emitRunFailed, toRunFailedError } from "@vite-hub/runtime/internal/run-failed"

import type { WorkflowDefinition } from "../types.ts"

/**
 * Sends `workflow.failed` to the listeners, such as Webhooks, when a run ends in failure with no retry left. An Agent
 * turn runs in an internal Workflow and reports `invocation.failed` from its Invocation instead.
 */
export async function emitWorkflowFailed(name: string, runId: string, error: unknown, definition: Pick<WorkflowDefinition, "internalAgentInvocationRecovery" | "internalAgentWorkflow"> | undefined): Promise<void> {
  if (definition?.internalAgentWorkflow || definition?.internalAgentInvocationRecovery) return
  await emitRunFailed({ event: "workflow.failed", workflow: name, runId, error: toRunFailedError(error), failedAt: new Date().toISOString() })
}
