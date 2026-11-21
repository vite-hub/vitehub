import { readQueueTimes } from "../duration.ts"
import { createQueueMessageId, normalizeQueueEnqueueInput } from "../enqueue.ts"
import { queueProviderResult, queueRemovedOptionsError, queueUnsupportedOptionsError } from "../errors.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveVercelQueueRegion } from "../internal/vercel-region.ts"

import type { Result } from "@vite-hub/runtime"
import type { QueueSendResult, VercelQueueBatchSendResult, VercelQueueClient, VercelQueueDriverOptions, VercelQueueSDK } from "../types.ts"

function invalidVercelSendResponse(cause: unknown): Result<never, "QUEUE_PROVIDER_INVALID_RESPONSE"> {
  return [queueErrorDiagnostics.QUEUE_PROVIDER_INVALID_RESPONSE({ cause }), undefined]
}

function isVercelQueueSDK(value: unknown): value is VercelQueueSDK {
  if (value === null || typeof value !== "object") return false
  try {
    if (Array.isArray(value)) return false
  }
  catch {
    return false
  }

  const hasCallableMethod = (name: "send" | "handleCallback") => {
    let owner: object | null = value
    while (owner && owner !== Object.prototype) {
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(owner, name)
      }
      catch {
        return false
      }
      if (descriptor) {
        if (owner !== value) {
          let constructor: PropertyDescriptor | undefined
          try {
            constructor = Object.getOwnPropertyDescriptor(owner, "constructor")
            if (!constructor || !("value" in constructor) || typeof constructor.value !== "function" || constructor.value.prototype !== owner) {
              return false
            }
          }
          catch {
            return false
          }
        }
        if ("value" in descriptor) return typeof descriptor.value === "function"
        try {
          return typeof Reflect.get(value, name) === "function"
        }
        catch {
          return false
        }
      }
      try {
        owner = Object.getPrototypeOf(owner)
      }
      catch {
        return false
      }
    }
    return false
  }

  return hasCallableMethod("send") && hasCallableMethod("handleCallback")
}

/** The cause of `QUEUE_PROVIDER_FAILED` when Vercel rejects jobs of a batch. `results` has each job's result in input order. */
function batchRejected(results: readonly VercelQueueBatchSendResult[]) {
  const failed = results.filter(result => result.status === "failed").length
  return Object.assign(queueErrorDiagnostics.QUEUE_VERCEL_BATCH_REJECTED({ failed, total: results.length }), { results })
}

function parseVercelBatchResults(value: unknown, length: number): Result<QueueSendResult[], "QUEUE_PROVIDER_INVALID_RESPONSE"> {
  if (!Array.isArray(value) || value.length !== length) return invalidVercelSendResponse(value)
  const results: QueueSendResult[] = []
  for (const entry of value) {
    const [error, messageId] = parseVercelMessageId(entry)
    if (error) return [error, undefined]
    results.push({ status: "queued", messageId })
  }
  return [undefined, results]
}

function parseVercelMessageId(value: unknown): Result<string | undefined, "QUEUE_PROVIDER_INVALID_RESPONSE"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidVercelSendResponse(value)

  let messageId: unknown
  try {
    if (!Object.prototype.hasOwnProperty.call(value, "messageId")) return invalidVercelSendResponse(value)
    messageId = Reflect.get(value, "messageId")
  }
  catch (cause) {
    return invalidVercelSendResponse(cause)
  }
  // `@vercel/queue` returns `messageId: null` when it accepts a message for deferred processing (HTTP 202).
  if (messageId === null) return [undefined, undefined]
  if (typeof messageId !== "string" || !messageId || messageId.length > 128 || messageId.trim() !== messageId) {
    return invalidVercelSendResponse(value)
  }
  return [undefined, messageId]
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
        // provider-message-match: Node reports a missing dynamic import callback only in this TypeError message.
        if (!(error instanceof TypeError) || !/dynamic import callback/i.test(error.message)) throw error
        module = await import(specifier) as Record<string, unknown>
      }
    }
  }
  catch (cause) {
    throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_UNAVAILABLE({ cause })
  }

  const { region: resolvedRegion } = resolveVercelQueueRegion(region)
  if (Object.hasOwn(module, "QueueClient") && typeof module.QueueClient === "function") {
    if (!resolvedRegion) {
      throw queueErrorDiagnostics.QUEUE_MISSING_REGION()
    }

    // SAFETY: QueueClient is an own callable export; the Vercel SDK defines its region constructor contract.
    return new (module.QueueClient as new (options: { region: string }) => VercelQueueSDK)({ region: resolvedRegion })
  }

  if (Object.hasOwn(module, "send") && Object.hasOwn(module, "handleCallback") && typeof module.send === "function" && typeof module.handleCallback === "function") {
    return {
      handleCallback: module.handleCallback as VercelQueueSDK["handleCallback"],
      send: module.send as VercelQueueSDK["send"],
      ...(Object.hasOwn(module, "sendBatch") && typeof module.sendBatch === "function" ? { sendBatch: module.sendBatch as VercelQueueSDK["sendBatch"] } : {}),
    }
  }

  throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_INVALID()
}

export async function createVercelQueueClient(provider: VercelQueueDriverOptions): Promise<VercelQueueClient> {
  const topic = provider.topic
  if (!topic) {
    throw queueErrorDiagnostics.QUEUE_MISSING_TOPIC()
  }

  const client = provider.client === undefined ? await loadVercelQueueClient(provider.region) : provider.client
  if (!isVercelQueueSDK(client)) {
    throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_INVALID()
  }
  return {
    provider: "vercel",
    native: client,
    topic,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const optionsError = queueUnsupportedOptionsError(normalized.options, "vercel")
      if (optionsError) return [optionsError, undefined]
      // Vercel takes whole seconds.
      const [timeError, times] = readQueueTimes(normalized.options, "ceil")
      if (timeError) return [timeError, undefined]

      const [error, response] = await queueProviderResult("vercel", "send", () => client.send(topic, normalized.payload, {
        delaySeconds: times.delaySeconds,
        idempotencyKey: normalized.options.idempotencyKey || normalized.id,
        region: normalized.options.region ?? provider.region,
        retentionSeconds: times.retentionSeconds,
      }))
      if (error) return [error, undefined]
      const [responseError, messageId] = parseVercelMessageId(response)
      if (responseError) return [responseError, undefined]
      return [undefined, { status: "queued", messageId }]
    },
    async sendBatch(items, options) {
      const removed = queueRemovedOptionsError("vercel", options, items)
      if (removed) return [removed, undefined]
      const messages: { delaySeconds?: number, idempotencyKey: string, payload: unknown, retentionSeconds?: number }[] = []
      for (const item of items) {
        const [timeError, times] = readQueueTimes({ delay: item.delay ?? options?.delay, retention: item.retention ?? options?.retention }, "ceil")
        if (timeError) return [timeError, undefined]
        messages.push({
          delaySeconds: times.delaySeconds,
          idempotencyKey: item.idempotencyKey || createQueueMessageId(),
          payload: item.body,
          retentionSeconds: times.retentionSeconds,
        })
      }
      const [error, response] = await queueProviderResult("vercel", "send-batch", async () => {
        if (typeof client.sendBatch !== "function") throw queueErrorDiagnostics.QUEUE_VERCEL_SEND_BATCH_UNAVAILABLE()
        const results = await client.sendBatch!(topic, messages)
        if (Array.isArray(results) && results.some(result => result?.status === "failed")) throw batchRejected(results)
        return results
      })
      if (error) return [error, undefined]
      return parseVercelBatchResults(response, messages.length)
    },
    callback: client.handleCallback.bind(client),
  }
}
