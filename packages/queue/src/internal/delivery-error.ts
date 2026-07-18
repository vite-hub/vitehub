import { QueueError } from "../errors.ts"

interface QueueDeliveryErrorContext {
  attempts: number
  id: string
  provider: "cloudflare" | "vercel"
  queue: string
}

interface QueueDeliveryErrorReport extends QueueDeliveryErrorContext {
  error: {
    code?: string
    details?: QueueError["details"]
    message: string
    name: string
  }
  retryable: boolean
}

export function isNonRetryableQueueError(error: unknown): boolean {
  return error instanceof QueueError && error.retryable === false
}

export function createQueueDeliveryErrorReport(error: unknown, context: QueueDeliveryErrorContext): QueueDeliveryErrorReport {
  const resolved = error instanceof Error ? error : new Error(String(error))
  return {
    ...context,
    error: {
      ...(error instanceof QueueError ? { code: error.code, details: error.details } : {}),
      message: resolved.message,
      name: resolved.name,
    },
    retryable: !isNonRetryableQueueError(error),
  }
}

export function reportQueueDeliveryError(error: unknown, context: QueueDeliveryErrorContext): void {
  console.error("[vitehub:queue] Queue Delivery failed.", createQueueDeliveryErrorReport(error, context))
}
