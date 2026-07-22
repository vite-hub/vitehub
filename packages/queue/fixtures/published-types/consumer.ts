import { ViteHubError } from "@vite-hub/runtime"

import type { QueueErrorCode, QueueErrorDetails } from "@vite-hub/queue"

const code = "QUEUE_PROVIDER_OPERATION_FAILED" satisfies QueueErrorCode
const details = {
  operation: "send",
  provider: "vercel",
} satisfies QueueErrorDetails<"QUEUE_PROVIDER_OPERATION_FAILED">

const error = new ViteHubError<typeof code, typeof details>(code, "Queue provider operation failed.", { details })
error.code satisfies QueueErrorCode
error.details satisfies QueueErrorDetails<typeof code> | undefined

// @ts-expect-error Queue operations use the closed ViteHub vocabulary.
const invalidDetails: QueueErrorDetails<"QUEUE_PROVIDER_OPERATION_FAILED"> = { operation: "cancel", provider: "vercel" }
void invalidDetails
