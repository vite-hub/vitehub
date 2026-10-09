import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { createQueueError, isQueueBoundaryIdentity, runQueueProviderOperation } from "../errors.ts"
import { resolveVercelQueueRegion } from "../internal/vercel-region.ts"

import type { VercelQueueClient, VercelQueueProviderOptions, VercelQueueSDK } from "../types.ts"

function invalidVercelSendResponse(cause: unknown): never {
  throw createQueueError("QUEUE_PROVIDER_RESPONSE_INVALID", {
    cause,
    details: { operation: "send", provider: "vercel" },
  })
}

function isRuntimeFunction(value: unknown): boolean {
  if (value === null || value === undefined || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  }
  catch {
    return false
  }
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

  const { region: resolvedRegion } = resolveVercelQueueRegion(region)
  if (Object.hasOwn(module, "QueueClient") && isRuntimeFunction(module.QueueClient)) {
    if (!resolvedRegion) {
      throw createQueueError("VERCEL_QUEUE_REGION_REQUIRED", {
        details: { provider: "vercel" },
      })
    }

    // SAFETY: QueueClient is an own callable export; the Vercel SDK defines its region constructor contract.
    return new (module.QueueClient as new (options: { region: string }) => VercelQueueSDK)({ region: resolvedRegion })
  }

  if (Object.hasOwn(module, "send") && Object.hasOwn(module, "handleCallback") && isRuntimeFunction(module.send) && isRuntimeFunction(module.handleCallback)) {
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
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
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
