import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { getRequestHeaders, getRequestURL, readRawBody } from "h3"

import { createQueueError } from "../errors.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { toResponse } from "@vite-hub/runtime"

import { dynamicQueue } from "./client.ts"

import type { QueueDefinition, VercelQueueCallbackOptions } from "../types.ts"

export const hostedVercelWaitUntil: (promise: Promise<unknown>) => void | undefined = vercelWaitUntil

function isRequestLike(value: unknown): value is Request {
  if (value === null || typeof value !== "object") return false

  const getter = Object.getOwnPropertyDescriptor(Request.prototype, "url")?.get
  if (getter) {
    try {
      getter.call(value)
      return true
    } catch {
      // Continue with the cross-implementation Fetch interface check below.
    }
  }

  // Hosted adapters can supply a different Fetch implementation. Its private
  // slots are not compatible with the host Request's accessors, even in Node.
  // Check the Fetch interface without cloning, locking, or consuming its body.
  // This is input normalization for host-provided values, not authentication.
  try {
    return "url" in value && typeof value.url === "string"
      && "method" in value && typeof value.method === "string"
      && "headers" in value && value.headers !== null && typeof value.headers === "object"
      && "get" in value.headers && typeof value.headers.get === "function"
      && "entries" in value.headers && typeof value.headers.entries === "function"
      && "body" in value && (value.body === null || (typeof value.body === "object"
        && "getReader" in value.body && typeof value.body.getReader === "function"))
      && "bodyUsed" in value && typeof value.bodyUsed === "boolean"
      && "arrayBuffer" in value && typeof value.arrayBuffer === "function"
      && "text" in value && typeof value.text === "function"
      && "json" in value && typeof value.json === "function"
      && "clone" in value && typeof value.clone === "function"
  } catch {
    return false
  }
}

async function toRequest(event: {
  method?: string
  request?: Request
}) {
  if (event.request instanceof Request || isRequestLike(event.request)) {
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
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vercel metadata is untyped at this boundary and must be validated before use.
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
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vercel metadata is untyped at this boundary and must be validated before use.
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
    throw createQueueError("VERCEL_PROVIDER_EXPECTED", {
      details: { provider: queue.provider },
    })
  }

  return await queue.callback(createVercelJobHandler(definition), createVercelCallbackOptions(name, definition.options?.callbackOptions))(await toRequest(event))
}
