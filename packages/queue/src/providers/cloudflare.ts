import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { cloudflareUnsupportedEnqueueOptions, createQueueError, runQueueProviderOperation } from "../errors.ts"
import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { toResponse } from "@vite-hub/runtime"

import type { CloudflareQueueBatchErrorAction, CloudflareQueueBatchHandlerOptions, CloudflareQueueBinding, CloudflareQueueClient, CloudflareQueueMessage, CloudflareQueueMessageBatch, CloudflareQueueProviderOptions, QueueEnqueueOptions } from "../types.ts"

function isCloudflareQueueBinding(binding: unknown): binding is CloudflareQueueBinding {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host bindings are untyped at this boundary; validate the object before inspecting its methods.
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return false

  const hasCallableMethod = (name: "send" | "sendBatch") => {
    let owner: object | null = binding
    while (owner && owner !== Object.prototype) {
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(owner, name)
      }
      catch {
        return false
      }
      if (descriptor) {
        if (owner !== binding) {
          const constructor = Object.getOwnPropertyDescriptor(owner, "constructor")
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- A callable constructor whose prototype owns the method identifies a class-backed host binding.
          if (!constructor || !("value" in constructor) || typeof constructor.value !== "function" || constructor.value.prototype !== owner) {
            return false
          }
        }
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Queue methods must be callable data properties before provider operations can use them.
        if ("value" in descriptor) return typeof descriptor.value === "function"
        try {
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Host accessors are accepted only when they return a callable queue method.
          return typeof Reflect.get(binding, name) === "function"
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

  return hasCallableMethod("send") && hasCallableMethod("sendBatch")
}

function toSendOptions(options: QueueEnqueueOptions = {}) {
  const unsupported = cloudflareUnsupportedEnqueueOptions.filter(option => options[option] !== undefined)

  if (unsupported.length) {
    throw createQueueError("CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS", {
      details: { provider: "cloudflare", unsupported },
    })
  }

  return {
    contentType: options.contentType,
    delaySeconds: options.delaySeconds,
  }
}

function resolveAction(action: CloudflareQueueBatchErrorAction | void, message: CloudflareQueueMessage, fallback: "ack" | "retry") {
  if (action === "ack") {
    message.ack()
    return
  }

  if (action === "retry") {
    message.retry()
    return
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JavaScript error hooks can return callable values with retry properties.
  if (action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "retry")) {
    message.retry(action.retry)
    return
  }

  if (fallback === "ack") {
    message.ack()
  } else {
    message.retry()
  }
}

export function createCloudflareQueueBatchHandler<TPayload = unknown>(options: CloudflareQueueBatchHandlerOptions<TPayload>) {
  const requested = Number(options.concurrency ?? 1)
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1

  return async (batch: CloudflareQueueMessageBatch<TPayload>): Promise<void> => {
    const messages = Array.isArray(batch?.messages) ? batch.messages : []
    if (!messages.length) {
      return
    }

    let index = 0
    const worker = async () => {
      while (index < messages.length) {
        const message = messages[index++]!
        try {
          const response = toResponse(await options.onMessage(message, batch))
          if (!response.ok) {
            const error = new Error(`Queue handler returned HTTP ${response.status}`)
            Object.assign(error, { status: response.status })
            throw error
          }
          message.ack()
        } catch (error) {
          reportQueueDeliveryError(error, {
            attempts: message.attempts,
            id: message.id,
            provider: "cloudflare",
            queue: getCloudflareQueueDefinitionName(batch.queue),
          })
          const action = options.onError ? await options.onError(error, message, batch) : undefined
          resolveAction(action, message, isNonRetryableQueueError(error) ? "ack" : "retry")
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()))
  }
}

export function createCloudflareQueueClient(provider: CloudflareQueueProviderOptions): CloudflareQueueClient {
  if (typeof provider.binding === "undefined" || typeof provider.binding === "string") {
    throw createQueueError("CLOUDFLARE_BINDING_RESOLUTION_REQUIRED", {
      details: { provider: "cloudflare" },
    })
  }

  if (!isCloudflareQueueBinding(provider.binding)) {
    throw createQueueError("CLOUDFLARE_BINDING_INVALID", {
      details: { provider: "cloudflare" },
    })
  }

  const binding = provider.binding
  return {
    provider: "cloudflare",
    native: binding,
    binding,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      await runQueueProviderOperation("cloudflare", "send", () =>
        binding.send(normalized.payload, toSendOptions(normalized.options)))
      return {
        status: "queued",
        messageId: normalized.id,
      }
    },
    async sendBatch(items, options) {
      await runQueueProviderOperation("cloudflare", "send-batch", () =>
        binding.sendBatch(items.map(item => ({
          ...item,
          ...toSendOptions({
            ...options,
            contentType: item.contentType || options?.contentType,
            delaySeconds: item.delaySeconds ?? options?.delaySeconds,
          }),
        }))))

      return items.map(() => ({ status: "queued" as const }))
    },
    createBatchHandler: createCloudflareQueueBatchHandler,
  }
}
