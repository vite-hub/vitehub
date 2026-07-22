import { getQueueErrorPublicShape, normalizePublicQueueIdentifier } from "../errors.ts"
import type { QueueErrorCode } from "../errors.ts"

const nonRetryableBuiltInCodes = new Set<string>([
  "CLOUDFLARE_BINDING_INVALID",
  "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED",
  "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS",
  "QUEUE_DEFINITION_LOAD_FAILED",
  "QUEUE_DEFINITION_NOT_FOUND",
  "QUEUE_DISABLED",
  "VERCEL_PROVIDER_EXPECTED",
  "VERCEL_QUEUE_REGION_REQUIRED",
  "VERCEL_QUEUE_SDK_INVALID",
  "VERCEL_QUEUE_SDK_LOAD_FAILED",
  "VERCEL_TOPIC_RESOLUTION_REQUIRED",
  "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS",
] satisfies QueueErrorCode[])

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
  const shape = getQueueErrorPublicShape(error)
  return shape !== undefined && nonRetryableBuiltInCodes.has(shape.code)
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
      name: queueError ? "ViteHubError" : "Error",
    },
    retryable: !isNonRetryableQueueError(error),
  }
}

export function reportQueueDeliveryError(error: unknown, context: QueueDeliveryErrorContext): void {
  console.error("[vitehub:queue] Queue Delivery failed.", createQueueDeliveryErrorReport(error, context))
}
