import { waitUntil as vercelWaitUntil } from "@vercel/functions"
import { getRequestHeaders, getRequestURL, readRawBody } from "h3"

import { QueueError } from "../errors.ts"

import { getQueue } from "./client.ts"

import type { QueueDefinition } from "../types.ts"

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

export async function handleHostedVercelQueueCallback(event: { method?: string, request?: Request }, name: string, definition: QueueDefinition): Promise<unknown> {
  const queue = await getQueue(name)
  if (queue.provider !== "vercel") {
    throw new QueueError(`Queue "${name}" resolved to provider "${queue.provider}", expected "vercel".`, {
      code: "VERCEL_PROVIDER_EXPECTED",
      httpStatus: 400,
      provider: queue.provider,
    })
  }

  return await queue.callback(createVercelJobHandler(definition), definition.options?.callbackOptions)(await toRequest(event))
}
