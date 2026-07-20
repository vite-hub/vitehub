import { ApplicationWorkflowError, WorkflowError } from "@vite-hub/workflow"

import type { ApplicationWorkflowErrorOptions, WorkflowErrorCode, WorkflowErrorOptions } from "@vite-hub/workflow"

const code = "WORKFLOW_DEFINITION_NOT_FOUND" satisfies WorkflowErrorCode
declare const dynamicCode: WorkflowErrorCode
const disabledOptions: WorkflowErrorOptions = { code: "WORKFLOW_DISABLED" }
const options = {
  code: "TRANSCRIPTION_FAILED" as const,
  details: { attempt: 2, provider: "vercel" },
  message: "Transcription failed.",
} satisfies ApplicationWorkflowErrorOptions
const applicationError = new ApplicationWorkflowError(options)

applicationError.code satisfies "TRANSCRIPTION_FAILED"
applicationError.toJSON().details satisfies { attempt: number, provider: string } | undefined

new WorkflowError({ code }) satisfies WorkflowError<"WORKFLOW_DEFINITION_NOT_FOUND">
new WorkflowError(disabledOptions)
new WorkflowError({
  code: dynamicCode,
  details: { operation: "start", provider: "vercel" },
}) satisfies WorkflowError<WorkflowErrorCode>
// @ts-expect-error Dynamic built-in codes must provide details for codes that require them.
new WorkflowError({ code: dynamicCode })

const providerOptions = {
  code: "WORKFLOW_PROVIDER_OPERATION_FAILED" as const,
  details: { operation: "start", provider: "vercel" as const, status: 503 },
} satisfies WorkflowErrorOptions<"WORKFLOW_PROVIDER_OPERATION_FAILED">
const providerError = new WorkflowError(providerOptions)

providerError.details?.operation satisfies string | undefined
// @ts-expect-error Built-in Workflow error details do not expose arbitrary keys.
void providerError.details?.token

new WorkflowError({
  code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
  details: {
    // @ts-expect-error Built-in Workflow operations use the closed ViteHub vocabulary.
    operation: "publish-secret",
    provider: "vercel",
  },
})

// @ts-expect-error Application codes require the explicit ApplicationWorkflowError boundary.
new WorkflowError({ code: "TRANSCRIPTION_FAILED", message: "Transcription failed." })

new ApplicationWorkflowError({
  code: "INVALID_DETAILS",
  // @ts-expect-error Application Workflow error details must be JSON-safe.
  details: { failedAt: new Date() },
  message: "Invalid details.",
})
