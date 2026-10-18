import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { Request as UndiciRequest } from "undici"
import { getRequestHeaders, getRequestURL, readRawBody } from "h3"

import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { toResponse } from "@vite-hub/runtime"

import { dynamicQueue } from "./client.ts"

import type { QueueDefinition, VercelQueueCallbackOptions } from "../types.ts"

export const hostedVercelWaitUntil: (promise: Promise<unknown>) => void | undefined = vercelWaitUntil

function isRequestLike(value: unknown): value is Request {
  if (value === null || typeof value !== "object") return false

  // Request accessors perform a non-spoofable internal-slot check. Keep the
  // accessors from trusted implementations instead of reading candidate
  // prototypes, which ordinary objects can control.
  const getters = [
    Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get,
    Object.getOwnPropertyDescriptor(UndiciRequest.prototype, "url")?.get,
  ].filter((getter): getter is NonNullable<typeof getter> => typeof getter === "function")

  return getters.some((getter) => {
    try {
      getter.call(value)
      return true
    } catch {
      return false
    }
  })
}

async function toRequest(event: {
  method?: string
  request?: Request
}) {
  // `instanceof` can invoke a proxy's traps; treat hostile callback values as
  // non-Requests and let the existing H3 normalization handle them.
  let sameRealmRequest = false
  try {
    sameRealmRequest = event.request instanceof Request
  } catch {
    sameRealmRequest = false
  }
  if (sameRealmRequest) {
    // SAFETY: The guarded instanceof check confirms the value is a Request from this realm.
    return event.request as Request
  }
  if (isRequestLike(event.request)) {
    return event.request
  }

  // SAFETY: Non-Request callback inputs use the H3 event shape accepted by these helpers.
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
    // SAFETY: Vercel supplies this optional delivery metadata shape to queue callbacks.
    const meta = metadata as { deliveryCount?: number, messageId?: string } | undefined
    return toResponse(await definition.handler({
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

export async function handleHostedVercelQueueCallback(event: { method?: string, request?: Request }, name: string, definition: QueueDefinition): Promise<unknown> {
  const queue = await dynamicQueue.get(name)
  if (queue.provider !== "vercel") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "vercel", provider: queue.provider })
  }

  return await queue.callback(createVercelJobHandler(definition), createVercelCallbackOptions(name, definition.options?.callbackOptions))(await toRequest(event))
}
