import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
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

  const event = getQueueRuntimeEvent() as { req?: { headers?: Headers | Record<string, unknown> }, request?: Request } | undefined
  const requestHeaders = event?.request instanceof Request ? event.request.headers : event?.req?.headers

  return readHeader(requestHeaders, "ce-vqsregion") || parseRegionFromVercelId(readHeader(requestHeaders, "x-vercel-id"))
}

async function loadVercelQueueClient(region: string | undefined): Promise<VercelQueueSDK> {
  let module: Record<string, unknown>
  try {
    module = await import("@vercel/queue")
  } catch (error) {
    throw new QueueError(`@vercel/queue load failed. Install it to use the Vercel provider. Original error: ${error instanceof Error ? error.message : error}`, {
      cause: error,
      code: "VERCEL_QUEUE_SDK_LOAD_FAILED",
      provider: "vercel",
    })
  }

  const resolvedRegion = resolveVercelRegion(region)
  if ("QueueClient" in module && typeof module.QueueClient === "function") {
    if (!resolvedRegion) {
      throw new QueueError("Vercel queue region could not be resolved. Set `queue.region`, `QUEUE_REGION`, or run inside a Vercel request context.", {
        code: "VERCEL_QUEUE_REGION_REQUIRED",
        httpStatus: 500,
        provider: "vercel",
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

  throw new QueueError("@vercel/queue does not expose the expected queue client API.", {
    code: "VERCEL_QUEUE_SDK_INVALID",
    provider: "vercel",
  })
}

export async function createVercelQueueClient(provider: VercelQueueProviderOptions): Promise<VercelQueueClient> {
  const topic = provider.topic
  if (!topic) {
    throw new QueueError("Vercel queue topics are derived from discovered queue names. Direct clients require a topic.", {
      code: "VERCEL_TOPIC_RESOLUTION_REQUIRED",
      httpStatus: 400,
      provider: "vercel",
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
        throw new QueueError("Vercel queue does not support enqueue options: contentType.", {
          code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS",
          details: { unsupported: ["contentType"] },
          httpStatus: 400,
          method: "send",
          provider: "vercel",
        })
      }

      return {
        status: "queued",
        messageId: (await client.send(topic, normalized.payload, {
          delaySeconds: normalized.options.delaySeconds,
          idempotencyKey: normalized.options.idempotencyKey || normalized.id,
          region: normalized.options.region,
          retentionSeconds: normalized.options.retentionSeconds,
        })).messageId ?? undefined,
      }
    },
    callback: client.handleCallback.bind(client),
  }
}
