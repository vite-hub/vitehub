import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { queueProviderResult } from "../errors.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveVercelQueueRegion } from "../internal/vercel-region.ts"

import type { Result } from "@vite-hub/runtime"
import type { VercelQueueClient, VercelQueueProviderOptions, VercelQueueSDK } from "../types.ts"

function invalidVercelSendResponse(cause: unknown): Result<never, "QUEUE_PROVIDER_INVALID_RESPONSE"> {
  return [queueErrorDiagnostics.QUEUE_PROVIDER_INVALID_RESPONSE({ cause }), undefined]
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
            if (!constructor || !("value" in constructor) || !isRuntimeFunction(constructor.value) || constructor.value.prototype !== owner) {
              return false
            }
          }
          catch {
            return false
          }
        }
        if ("value" in descriptor) return isRuntimeFunction(descriptor.value)
        try {
          return isRuntimeFunction(Reflect.get(value, name))
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
        if (!(error instanceof TypeError) || !/dynamic import callback/i.test(error.message)) throw error
        module = await import(specifier) as Record<string, unknown>
      }
    }
  }
  catch (cause) {
    throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_UNAVAILABLE({ cause })
  }

  const { region: resolvedRegion } = resolveVercelQueueRegion(region)
  if (Object.hasOwn(module, "QueueClient") && isRuntimeFunction(module.QueueClient)) {
    if (!resolvedRegion) {
      throw queueErrorDiagnostics.QUEUE_MISSING_REGION()
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

  throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_INVALID()
}

export async function createVercelQueueClient(provider: VercelQueueProviderOptions): Promise<VercelQueueClient> {
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
      if (normalized.options.contentType !== undefined) {
        return [queueErrorDiagnostics.QUEUE_UNSUPPORTED_OPTION({ options: "`contentType`", provider: "vercel" }), undefined]
      }

      const [error, response] = await queueProviderResult("vercel", "send", () => client.send(topic, normalized.payload, {
        delaySeconds: normalized.options.delaySeconds,
        idempotencyKey: normalized.options.idempotencyKey || normalized.id,
        region: normalized.options.region ?? provider.region,
        retentionSeconds: normalized.options.retentionSeconds,
      }))
      if (error) return [error, undefined]
      const [responseError, messageId] = parseVercelMessageId(response)
      if (responseError) return [responseError, undefined]
      return [undefined, { status: "queued", messageId }]
    },
    callback: client.handleCallback.bind(client),
  }
}
