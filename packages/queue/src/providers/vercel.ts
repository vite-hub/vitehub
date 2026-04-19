import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import type {
  QueueEnqueueOptions,
  VercelQueueClient,
  VercelQueueProviderOptions,
  VercelQueueSDK,
} from "../types.ts"

interface VercelQueueModule {
  QueueClient?: new(options?: Record<string, unknown>) => VercelQueueSDK
  handleCallback?: VercelQueueSDK["handleCallback"]
  send?: VercelQueueSDK["send"]
}

function getUnsupportedOptions(options: QueueEnqueueOptions) {
  return [
    options.contentType !== undefined ? "contentType" : undefined,
  ].filter((item): item is string => Boolean(item))
}

async function loadVercelQueueClient(region?: string): Promise<VercelQueueSDK> {
  let module: VercelQueueModule
  try {
    module = await import(/* @vite-ignore */ ["@vercel", "queue"].join("/")) as VercelQueueModule
  }
  catch (error) {
    throw new QueueError(`@vercel/queue load failed. Install it to use the Vercel provider. Original error: ${error instanceof Error ? error.message : error}`, {
      cause: error,
      code: "VERCEL_QUEUE_SDK_LOAD_FAILED",
      provider: "vercel",
    })
  }

  if (module.QueueClient) return new module.QueueClient(region ? { region } : undefined)
  if (module.send && module.handleCallback) {
    return {
      handleCallback: module.handleCallback,
      send: module.send,
    }
  }

  throw new QueueError("@vercel/queue does not expose the expected queue client API.", {
    code: "VERCEL_QUEUE_SDK_INVALID",
    provider: "vercel",
  })
}

export async function createVercelQueueClient(
  provider: VercelQueueProviderOptions,
): Promise<VercelQueueClient> {
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
      const unsupported = getUnsupportedOptions(normalized.options)
      if (unsupported.length) {
        throw new QueueError(`Vercel queue does not support enqueue options: ${unsupported.join(", ")}.`, {
          code: "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS",
          details: { unsupported },
          httpStatus: 400,
          method: "send",
          provider: "vercel",
        })
      }

      const result = await client.send(topic, normalized.payload, {
        delaySeconds: normalized.options.delaySeconds,
        idempotencyKey: normalized.options.idempotencyKey || normalized.id,
        region: normalized.options.region,
        retentionSeconds: normalized.options.retentionSeconds,
      })

      return {
        status: "queued",
        messageId: result.messageId ?? undefined,
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
