import { QueueError, type QueueErrorOptions } from "@vite-hub/queue"

const options = {
  code: "INVALID_PAYLOAD",
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
  message: "[vitehub] vercel queue provider failed during send.",
})

// @ts-expect-error Custom codes require an explicit QueueError generic.
new QueueError({ code: "INVALID_PAYLOAD", message: "Invalid payload." })
new QueueError({
  code: "QUEUE_PROVIDER_OPERATION_FAILED",
  // @ts-expect-error Built-in details are code-specific.
  details: { operation: "cancel", provider: "vercel" },
  message: "Provider failed.",
})
// @ts-expect-error The legacy message-first constructor was removed.
new QueueError("Provider failed.")
