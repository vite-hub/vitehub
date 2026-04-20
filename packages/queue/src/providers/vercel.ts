import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"

import type { VercelQueueClient, VercelQueueProviderOptions, VercelQueueSDK } from "../types.ts"

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

  if ("QueueClient" in module && typeof module.QueueClient === "function") {
    return new (module.QueueClient as new (options?: { region?: string }) => VercelQueueSDK)(region ? { region } : undefined)
  }

  if (typeof module.send === "function" && typeof module.handleCallback === "function") {
    return {
      handleCallback: module.handleCallback as VercelQueueSDK["handleCallback"],
      handleNodeCallback: typeof module.handleNodeCallback === "function" ? module.handleNodeCallback as VercelQueueSDK["handleNodeCallback"] : undefined,
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
    callback: client.handleCallback,
    nodeCallback: client.handleNodeCallback || (() => {
      throw new QueueError("@vercel/queue handleNodeCallback is not available on this client.", {
        code: "VERCEL_NODE_CALLBACK_UNAVAILABLE",
        httpStatus: 400,
        provider: "vercel",
      })
    }),
  }
}
