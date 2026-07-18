import { QueueError, type QueueErrorOptions } from "@vite-hub/queue"

const options = {
  code: "INVALID_PAYLOAD",
  custom: true,
  details: { field: "email" },
  message: "Invalid payload.",
  retryable: false,
} satisfies QueueErrorOptions<"INVALID_PAYLOAD">

const error = new QueueError<"INVALID_PAYLOAD">(options)
error.code satisfies "INVALID_PAYLOAD"
error.retryable satisfies boolean | undefined

new QueueError({
  code: "QUEUE_PROVIDER_OPERATION_FAILED",
  details: { operation: "send", provider: "vercel" },
})
new QueueError({
  code: "QUEUE_PROVIDER_RESPONSE_INVALID",
  details: { operation: "send", provider: "vercel" },
  message: "[vitehub] Vercel queue provider returned an invalid send response.",
})

// @ts-expect-error Custom codes require an explicit QueueError generic.
new QueueError({ code: "INVALID_PAYLOAD", message: "Invalid payload." })
new QueueError({
  code: "QUEUE_PROVIDER_OPERATION_FAILED",
  // @ts-expect-error Built-in details are code-specific.
  details: { operation: "cancel", provider: "vercel" },
})
// @ts-expect-error Built-in retry policy is owned by ViteHub.
new QueueError({ code: "QUEUE_DISABLED", retryable: false })
// @ts-expect-error The legacy message-first constructor was removed.
new QueueError("Provider failed.")
