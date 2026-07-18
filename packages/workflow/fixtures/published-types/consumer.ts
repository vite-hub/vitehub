import { WorkflowError } from "@vite-hub/workflow"

import type { WorkflowErrorCode, WorkflowErrorOptions } from "@vite-hub/workflow"

const code = "WORKFLOW_DEFINITION_NOT_FOUND" satisfies WorkflowErrorCode
const options = {
  code: "TRANSCRIPTION_FAILED" as const,
  details: { attempt: 2, provider: "vercel" },
  message: "Transcription failed.",
} satisfies WorkflowErrorOptions
const error = new WorkflowError(options)

error.code satisfies "TRANSCRIPTION_FAILED"
error.toJSON().details satisfies { attempt: number, provider: string } | undefined

new WorkflowError({
  code,
  message: "Workflow definition not found.",
})

new WorkflowError({
  code: "INVALID_DETAILS",
  // @ts-expect-error Workflow error details must be JSON-safe.
  details: { failedAt: new Date() },
  message: "Invalid details.",
})
