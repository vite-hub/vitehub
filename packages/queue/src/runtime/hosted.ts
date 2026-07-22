import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { getRequestHeaders, getRequestURL, readRawBody } from "h3"

import { createQueueError } from "../errors.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"

import { getQueue } from "./client.ts"

import type { QueueDefinition, VercelQueueCallbackOptions } from "../types.ts"

export const hostedVercelWaitUntil: typeof vercelWaitUntil = vercelWaitUntil

async function toRequest(event: {
  method?: string
  request?: Request
}) {
  if (event.request instanceof Request) {
    return event.request
  }

  const h3Event = event as never
  const body = await readRawBody(h3Event)
  return new Request(getRequestURL(h3Event), {
    body: body || undefined,
    headers: getRequestHeaders(h3Event),
    method: event.method || "POST",
  })
}

function createVercelJobHandler(definition: QueueDefinition) {
  return async (payload: unknown, metadata?: unknown) => {
    const meta = metadata as { deliveryCount?: number, messageId?: string } | undefined
    await definition.handler({
      attempts: typeof meta?.deliveryCount === "number" ? meta.deliveryCount : 1,
      id: typeof meta?.messageId === "string" ? meta.messageId : "vercel-message",
      metadata,
      payload,
    })
  }
}

function createVercelCallbackOptions(name: string, options: VercelQueueCallbackOptions | undefined): VercelQueueCallbackOptions {
  const retry = options?.retry
  return {
    ...options,
    retry(error, metadata) {
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

export async function handleHostedVercelQueueCallback(event: { method?: string, request?: Request }, name: string, definition: QueueDefinition): Promise<unknown> {
  const queue = await getQueue(name)
  if (queue.provider !== "vercel") {
    throw createQueueError("VERCEL_PROVIDER_EXPECTED", {
      details: { provider: queue.provider },
    })
  }

  return await queue.callback(createVercelJobHandler(definition), createVercelCallbackOptions(name, definition.options?.callbackOptions))(await toRequest(event))
}
