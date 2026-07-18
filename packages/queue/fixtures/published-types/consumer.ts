import { QueueError, type QueueErrorMetadata, type QueueErrorOptions } from "@vite-hub/queue"

const options = {
  code: "INVALID_PAYLOAD",
  details: { field: "email" },
  httpStatus: 422,
  message: "Invalid payload.",
  method: "POST",
  provider: "vercel",
  retryable: false,
} satisfies QueueErrorOptions<"INVALID_PAYLOAD">

const error = new QueueError<"INVALID_PAYLOAD">(options)
error.code satisfies "INVALID_PAYLOAD"
error.httpStatus satisfies number | undefined
error.method satisfies string | undefined
error.provider satisfies string | undefined
error.retryable satisfies boolean | undefined

const metadata = {
  code: "INVALID_PAYLOAD",
  details: { field: "email" },
  httpStatus: 422,
  method: "POST",
  provider: "vercel",
  retryable: false,
} satisfies QueueErrorMetadata

const compatibleError = new QueueError("Invalid payload.", metadata)
compatibleError.httpStatus satisfies number | undefined
compatibleError.method satisfies string | undefined
compatibleError.provider satisfies string | undefined

new QueueError({
  code: "QUEUE_PROVIDER_OPERATION_FAILED",
  details: { operation: "send", provider: "vercel" },
  message: "[vitehub] vercel queue provider failed during send.",
})

// @ts-expect-error Custom codes require an explicit QueueError generic.
new QueueError({ code: "INVALID_PAYLOAD", message: "Invalid payload." })
// @ts-expect-error Built-in details are code-specific.
new QueueError({
  code: "QUEUE_PROVIDER_OPERATION_FAILED",
  details: { operation: "cancel", provider: "vercel" },
  message: "Provider failed.",
})
new QueueError("Provider failed.", { httpStatus: 503, method: "POST", provider: "vercel", retryable: true })
