import { getQueueErrorPublicShape, normalizePublicQueueIdentifier } from "../errors.ts"

interface QueueDeliveryErrorContext {
  attempts: number
  id: string
  provider: "cloudflare" | "vercel"
  queue: string
}

interface QueueDeliveryErrorReport extends Omit<QueueDeliveryErrorContext, "id" | "queue"> {
  id?: string
  queue?: string
  error: {
    code?: string
    details?: Readonly<Record<string, unknown>>
    message: string
    name: string
  }
  retryable: boolean
}

export function isNonRetryableQueueError(error: unknown): boolean {
  return getQueueErrorPublicShape(error)?.retryable === false
}

export function createQueueDeliveryErrorReport(error: unknown, context: QueueDeliveryErrorContext): QueueDeliveryErrorReport {
  const queueError = getQueueErrorPublicShape(error)
  const id = normalizePublicQueueIdentifier(context.id)
  const queue = normalizePublicQueueIdentifier(context.queue)
  return {
    attempts: context.attempts,
    provider: context.provider,
    ...(id ? { id } : {}),
    ...(queue ? { queue } : {}),
    error: {
      ...(queueError ? { code: queueError.code, details: queueError.details } : {}),
      message: queueError?.message ?? "[vitehub] Queue Delivery failed.",
      name: queueError ? "QueueError" : "Error",
    },
    retryable: !isNonRetryableQueueError(error),
  }
}

export function reportQueueDeliveryError(error: unknown, context: QueueDeliveryErrorContext): void {
  console.error("[vitehub:queue] Queue Delivery failed.", createQueueDeliveryErrorReport(error, context))
}
