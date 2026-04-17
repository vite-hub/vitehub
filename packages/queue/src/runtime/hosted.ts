import { getRequestHeaders, getRequestURL, readRawBody } from "h3"
import type { H3Event } from "h3"

import { getQueue } from "../index.ts"
import { QueueError } from "../errors.ts"
import type { QueueDefinition, QueueJob, VercelQueueMessageHandler } from "../types.ts"

async function toRequest(event: H3Event): Promise<Request> {
  const existing = (event as H3Event & { request?: Request }).request
  if (existing instanceof Request) return existing

  const body = await readRawBody(event)
  return new Request(getRequestURL(event), {
    body: body || undefined,
    headers: getRequestHeaders(event),
    method: event.method || "POST",
  })
}

function createVercelJobHandler(definition: QueueDefinition): VercelQueueMessageHandler {
  return async (payload, metadata) => {
    const meta = metadata as { deliveryCount?: number, messageId?: string } | undefined
    const job: QueueJob = {
      attempts: typeof meta?.deliveryCount === "number" ? meta.deliveryCount : 1,
      id: typeof meta?.messageId === "string" ? meta.messageId : "vercel-message",
      metadata,
      payload,
      signal: new AbortController().signal,
    }
    await definition.handler(job)
  }
}

export async function handleHostedVercelQueueCallback(
  event: H3Event,
  name: string,
  definition: QueueDefinition,
): Promise<unknown> {
  const queue = await getQueue(name)
  if (queue.provider !== "vercel") {
    throw new QueueError(`Queue "${name}" resolved to provider "${queue.provider}", expected "vercel".`, {
      code: "VERCEL_PROVIDER_EXPECTED",
      httpStatus: 400,
      provider: queue.provider,
    })
  }

  const handler = queue.callback(createVercelJobHandler(definition), definition.options?.callbackOptions)
  return await handler(await toRequest(event))
}
