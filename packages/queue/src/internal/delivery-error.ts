import { getViteHubErrorShape } from "@vite-hub/runtime"
import type { InferDiagnosticCodes } from "nostics"

import type { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"

import type { QueueDeliveryErrorDetails, QueueDriver } from "../types.ts"

const retryableQueueCodes: ReadonlySet<InferDiagnosticCodes<typeof queueErrorDiagnostics>> = new Set(["QUEUE_PROVIDER_FAILED", "QUEUE_PROVIDER_INVALID_RESPONSE"])

interface QueueDeliveryErrorContext {
  attempts: number
  development?: boolean
  id: string
  provider: QueueDriver
  queue: string
}

interface QueueDeliveryErrorReport extends Omit<QueueDeliveryErrorContext, "development" | "id" | "queue"> {
  id?: string
  queue?: string
  error: QueueDeliveryErrorDetails
  retryable: boolean
}

export function isNonRetryableQueueError(error: unknown): boolean {
  return isQueueError(error) && !retryableQueueCodes.has(error.code)
}

function toReportError(error: unknown, development: boolean): QueueDeliveryErrorReport["error"] {
  if (isQueueError(error)) {
    return { code: error.code, docs: error.docs, fix: error.fix, message: error.why, name: error.name }
  }
  const shape = getViteHubErrorShape(error)
  if (shape) return { code: shape.code, details: shape.details, message: shape.message, name: "ViteHubError" }
  if (development && error instanceof Error) return { message: error.message, name: error.name, ...(error.stack ? { stack: error.stack } : {}) }
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
    error: toReportError(error, context.development === true),
    retryable: !isNonRetryableQueueError(error),
  }
}

export function reportQueueDeliveryError(error: unknown, context: QueueDeliveryErrorContext): void {
  console.error("[vitehub:queue] Queue Delivery failed.", createQueueDeliveryErrorReport(error, context))
}
