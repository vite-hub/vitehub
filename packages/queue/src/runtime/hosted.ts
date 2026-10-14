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
  // Probe the implementation's accessors instead of accepting ordinary fields;
  // this avoids treating a plain object (or a single spoofed `url` getter) as a
  // Request, and does not clone, lock, or consume the body.
  try {
    let prototype = Object.getPrototypeOf(value)
    while (prototype && !Object.prototype.hasOwnProperty.call(prototype, "url")) {
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!prototype) return false

    const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
    if (typeof constructor !== "function" || constructor.prototype !== prototype) return false

    // Fetch implementations expose the Request brand through the prototype's
    // toString tag. Require that tag to come from the same prototype as the
    // accessors above, so an object-level Symbol.toStringTag cannot spoof it.
    const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)
    if (tag?.value !== "Request" && typeof tag?.get !== "function") return false

    const getters = [
      "url",
      "method",
      "headers",
      "body",
      "bodyUsed",
      "signal",
      "destination",
      "referrer",
      "referrerPolicy",
      "mode",
      "credentials",
      "cache",
      "redirect",
      "integrity",
      "keepalive",
    ] as const
    for (const key of getters) {
      const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get
      if (!getter) return false
      getter.call(value)
    }
    for (const key of ["clone", "text", "json", "arrayBuffer"] as const) {
      if (typeof Object.getOwnPropertyDescriptor(prototype, key)?.value !== "function") return false
    }
    return true
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
