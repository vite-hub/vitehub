import { waitUntil as vercelWaitUntil } from "@vercel/functions"

import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"

import { dynamicQueue } from "./client.ts"

import type { QueueDefinition, VercelQueueCallbackOptions } from "../types.ts"

export const hostedVercelWaitUntil: (promise: Promise<unknown>) => void | undefined = vercelWaitUntil

function createVercelJobHandler(definition: QueueDefinition) {
  return async (payload: unknown, metadata?: unknown) => {
    // SAFETY: Vercel supplies this optional delivery metadata shape to queue callbacks.
    const meta = metadata as { deliveryCount?: number, messageId?: string } | undefined
    checkQueueHandlerResponse(await definition.handler({
      attempts: typeof meta?.deliveryCount === "number" ? meta.deliveryCount : 1,
      id: typeof meta?.messageId === "string" ? meta.messageId : "vercel-message",
      metadata,
      payload,
    }))
  }
}

function createVercelCallbackOptions(name: string, options: VercelQueueCallbackOptions | undefined): VercelQueueCallbackOptions {
  const retry = options?.retry
  return {
    ...options,
    retry(error, metadata) {
      // SAFETY: Vercel supplies this optional delivery metadata shape to retry callbacks.
      const meta = metadata as { deliveryCount?: number, messageId?: string } | undefined
      reportQueueDeliveryError(error, {
        attempts: typeof meta?.deliveryCount === "number" ? meta.deliveryCount : 1,
        id: typeof meta?.messageId === "string" ? meta.messageId : "vercel-message",
        provider: "vercel",
        queue: name,
      })

      const directive = retry?.(error, metadata)
      if (directive !== undefined) {
        return directive
      }

      if (isNonRetryableQueueError(error)) {
        return { acknowledge: true }
      }
    },
  }
}

/** Handle one Vercel Queue delivery. The generated consumer route is a Fetchable module that passes its Request here. */
export async function handleHostedVercelQueueCallback(request: Request, name: string, definition: QueueDefinition): Promise<Response> {
  const queue = await dynamicQueue.use(name)
  if (queue.provider !== "vercel") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "vercel", provider: queue.provider })
  }

  const result = await queue.callback(createVercelJobHandler(definition), createVercelCallbackOptions(name, definition.options?.callbackOptions))(request)
  if (result instanceof Response) return result
  return result === undefined ? new Response(null, { status: 204 }) : Response.json(result)
}
