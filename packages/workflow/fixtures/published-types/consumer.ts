import { ViteHubError } from "@vite-hub/runtime"

import type { WorkflowErrorCode, WorkflowErrorDetails } from "@vite-hub/workflow"

const code = "WORKFLOW_DEFINITION_NOT_FOUND" satisfies WorkflowErrorCode
const details = {
  operation: "start",
  provider: "vercel",
  status: 503,
} satisfies WorkflowErrorDetails<"WORKFLOW_PROVIDER_OPERATION_FAILED">

new ViteHubError(code, "Workflow definition was not found.")
new ViteHubError<"WORKFLOW_PROVIDER_OPERATION_FAILED", typeof details>(
  "WORKFLOW_PROVIDER_OPERATION_FAILED",
  "Workflow provider operation failed.",
  { details },
)

// @ts-expect-error Workflow provider names use the closed ViteHub vocabulary.
const invalidDetails: WorkflowErrorDetails<"WORKFLOW_PROVIDER_OPERATION_FAILED"> = { operation: "start", provider: "custom" }
void invalidDetails
