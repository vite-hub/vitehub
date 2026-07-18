import { QueueError, type QueueErrorOptions } from "@vite-hub/queue"

const options = {
  code: "INVALID_PAYLOAD",
  details: { field: "email" },
  message: "Invalid payload.",
  retryable: false,
} satisfies QueueErrorOptions

const error = new QueueError(options)
error.code satisfies string
error.retryable satisfies boolean | undefined
new QueueError("Provider failed.", { provider: "vercel" })
