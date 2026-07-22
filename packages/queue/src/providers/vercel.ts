import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { createQueueError, isQueueBoundaryIdentity, runQueueProviderOperation } from "../errors.ts"
import { getQueueRuntimeEvent } from "../runtime/state.ts"

import type { VercelQueueClient, VercelQueueProviderOptions, VercelQueueSDK } from "../types.ts"

function readHeader(headers: Headers | Record<string, unknown> | undefined, name: string) {
  if (!headers) {
    return
  }

  if (headers instanceof Headers) {
    return headers.get(name) || undefined
  }

  const value = headers[name] ?? headers[name.toLowerCase()]
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined
  }
}

function parseRegionFromVercelId(value: string | undefined) {
  if (!value) {
    return
  }

  const match = value.match(/^([a-z0-9]+)::/i)
  return match?.[1]?.toLowerCase()
}

function resolveVercelRegion(explicitRegion: string | undefined) {
  if (explicitRegion) {
    return explicitRegion
  }

  if (typeof process.env.QUEUE_REGION === "string" && process.env.QUEUE_REGION) {
    return process.env.QUEUE_REGION
  }

  if (typeof process.env.VERCEL_REGION === "string" && process.env.VERCEL_REGION) {
    return process.env.VERCEL_REGION
  }

  const event = getQueueRuntimeEvent() as { node?: { req?: { headers?: Headers | Record<string, unknown> } }, req?: { headers?: Headers | Record<string, unknown> }, request?: Request } | undefined
  const requestHeaders = event?.request instanceof Request ? event.request.headers : event?.req?.headers ?? event?.node?.req?.headers

  return readHeader(requestHeaders, "ce-vqsregion") || parseRegionFromVercelId(readHeader(requestHeaders, "x-vercel-id"))
}

function invalidVercelSendResponse(cause: unknown): never {
  throw createQueueError("QUEUE_PROVIDER_RESPONSE_INVALID", {
    cause,
    details: { operation: "send", provider: "vercel" },
  })
}

function parseVercelMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidVercelSendResponse(value)

  let messageId: unknown
  try {
    messageId = Reflect.get(value, "messageId")
  }
  catch (cause) {
    invalidVercelSendResponse(cause)
  }
  if (messageId === undefined || messageId === null) return
  if (typeof messageId !== "string" || !messageId || messageId.length > 128 || messageId.trim() !== messageId) {
    invalidVercelSendResponse(value)
  }
  return messageId
}

async function loadVercelQueueClient(region: string | undefined): Promise<VercelQueueSDK> {
  let module: Record<string, unknown>
  try {
    const loaded = (globalThis as Record<string, unknown>).__vitehubVercelQueue
    if (loaded && typeof loaded === "object") {
      module = loaded as Record<string, unknown>
    } else {
      const importVercelQueue = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>
      const specifier = "@vercel/queue"
      try {
        module = await importVercelQueue(specifier)
      }
      catch (error) {
        if (!(error instanceof TypeError) || !/dynamic import callback/i.test(error.message)) throw error
        module = await import(specifier) as Record<string, unknown>
      }
    }
  }
  catch (error) {
    if (isQueueBoundaryIdentity(error)) throw error
    throw createQueueError("VERCEL_QUEUE_SDK_LOAD_FAILED", {
      cause: error,
      details: { operation: "load-sdk", provider: "vercel" },
    })
  }

  const resolvedRegion = resolveVercelRegion(region)
  if ("QueueClient" in module && typeof module.QueueClient === "function") {
    if (!resolvedRegion) {
      throw createQueueError("VERCEL_QUEUE_REGION_REQUIRED", {
        details: { provider: "vercel" },
      })
    }

    return new (module.QueueClient as new (options: { region: string }) => VercelQueueSDK)({ region: resolvedRegion })
  }

  if (typeof module.send === "function" && typeof module.handleCallback === "function") {
    return {
      handleCallback: module.handleCallback as VercelQueueSDK["handleCallback"],
      send: module.send as VercelQueueSDK["send"],
    }
  }

  throw createQueueError("VERCEL_QUEUE_SDK_INVALID", {
    details: { provider: "vercel" },
  })
}

export async function createVercelQueueClient(provider: VercelQueueProviderOptions): Promise<VercelQueueClient> {
  const topic = provider.topic
  if (!topic) {
    throw createQueueError("VERCEL_TOPIC_RESOLUTION_REQUIRED", {
      details: { provider: "vercel" },
    })
  }

  const client = provider.client || await loadVercelQueueClient(provider.region)
  return {
    provider: "vercel",
    native: client,
    topic,
    async send(input) {
      const normalized = normalizeQueueEnqueueInput(input)
      if (normalized.options.contentType !== undefined) {
        throw createQueueError("VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS", {
          details: { provider: "vercel", unsupported: ["contentType"] },
        })
      }

      const messageId = await runQueueProviderOperation("vercel", "send", async () =>
        parseVercelMessageId(await client.send(topic, normalized.payload, {
          delaySeconds: normalized.options.delaySeconds,
          idempotencyKey: normalized.options.idempotencyKey || normalized.id,
          region: normalized.options.region ?? provider.region,
          retentionSeconds: normalized.options.retentionSeconds,
        })))
      return {
        status: "queued",
        messageId,
      }
    },
    callback: client.handleCallback.bind(client),
  }
}
