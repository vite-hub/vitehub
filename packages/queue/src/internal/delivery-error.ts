import { getViteHubErrorShape } from "@vite-hub/runtime"

import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"

// A provider failure can pass on the next delivery. Every other Queue error needs a code or deployment change.
const retryableQueueCodes = new Set<string>(["QUEUE_PROVIDER_FAILED", "QUEUE_PROVIDER_INVALID_RESPONSE"])

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
    docs?: string
    fix?: string
    message: string
    name: string
  }
  retryable: boolean
}

export function isNonRetryableQueueError(error: unknown): boolean {
  return isQueueError(error) && !retryableQueueCodes.has(error.code)
}

function toReportError(error: unknown): QueueDeliveryErrorReport["error"] {
  if (isQueueError(error)) {
    return { code: error.code, docs: error.docs, fix: error.fix, message: error.why, name: error.name }
  }
  // Application code can throw a `ViteHubError` with its own code.
  const shape = getViteHubErrorShape(error)
  if (shape) return { code: shape.code, details: shape.details, message: shape.message, name: "ViteHubError" }
  return { message: "[vitehub] Queue Delivery failed.", name: "Error" }
}

export function createQueueDeliveryErrorReport(error: unknown, context: QueueDeliveryErrorContext): QueueDeliveryErrorReport {
  const id = normalizePublicQueueIdentifier(context.id)
  const queue = normalizePublicQueueIdentifier(context.queue)
  return {
    attempts: context.attempts,
    provider: context.provider,
    ...(id ? { id } : {}),
    ...(queue ? { queue } : {}),
    error: toReportError(error),
    retryable: !isNonRetryableQueueError(error),
  }
}

export function reportQueueDeliveryError(error: unknown, context: QueueDeliveryErrorContext): void {
  console.error("[vitehub:queue] Queue Delivery failed.", createQueueDeliveryErrorReport(error, context))
}
