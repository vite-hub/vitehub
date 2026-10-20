import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { cloudflareUnsupportedEnqueueOptions, formatQueueOptionNames, queueProviderResult } from "../errors.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { toResponse } from "@vite-hub/runtime"

import type { Result } from "@vite-hub/runtime"

import type { CloudflareQueueBatchErrorAction, CloudflareQueueBatchHandlerOptions, CloudflareQueueBinding, CloudflareQueueClient, CloudflareQueueMessage, CloudflareQueueMessageBatch, CloudflareQueueProviderOptions, QueueEnqueueOptions } from "../types.ts"

interface CloudflareSendOptions {
  contentType?: QueueEnqueueOptions["contentType"]
  delaySeconds?: number
}

// Worker binding names are identifiers. Only those go into the error `why`, which can reach public responses.
const cloudflareBindingName = /^[A-Z_]\w{0,127}$/i

function isCloudflareQueueBinding(binding: unknown): binding is CloudflareQueueBinding {
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
          if (!constructor || !("value" in constructor) || typeof constructor.value !== "function" || constructor.value.prototype !== owner) {
            return false
          }
        }
        if ("value" in descriptor) return typeof descriptor.value === "function"
        try {
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

function toSendOptions(options: QueueEnqueueOptions = {}): Result<CloudflareSendOptions, "QUEUE_UNSUPPORTED_OPTION"> {
  const unsupported = cloudflareUnsupportedEnqueueOptions.filter(option => options[option] !== undefined)

  if (unsupported.length) {
    return [queueErrorDiagnostics.QUEUE_UNSUPPORTED_OPTION({ options: formatQueueOptionNames(unsupported), provider: "cloudflare" }), undefined]
  }

  return [undefined, {
    contentType: options.contentType,
    delaySeconds: options.delaySeconds,
  }]
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
          const reportContext = {
            attempts: message.attempts,
            id: message.id,
            provider: "cloudflare",
            queue: getCloudflareQueueDefinitionName(batch.queue),
          } as const
          reportQueueDeliveryError(error, reportContext)
          let action: CloudflareQueueBatchErrorAction | void = undefined
          let hookFailed = false
          if (options.onError) {
            try {
              action = await options.onError(error, message, batch)
            }
            catch (hookError) {
              hookFailed = true
              reportQueueDeliveryError(hookError, reportContext)
            }
          }
          resolveAction(action, message, hookFailed || !isNonRetryableQueueError(error) ? "retry" : "ack")
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()))
  }
}

export function createCloudflareQueueClient(provider: CloudflareQueueProviderOptions): CloudflareQueueClient {
  if (typeof provider.binding === "undefined" || typeof provider.binding === "string") {
    // A binding name means the runtime looked it up in the request env and did not find it.
    const binding = typeof provider.binding === "string" && cloudflareBindingName.test(provider.binding) ? provider.binding : undefined
    throw queueErrorDiagnostics.QUEUE_BINDING_NOT_FOUND({ binding })
  }

  if (!isCloudflareQueueBinding(provider.binding)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_BINDING()
  }

  const binding = provider.binding
  return {
    provider: "cloudflare",
    native: binding,
    binding,
    async send(payload, options) {
      const normalized = normalizeQueueEnqueueInput(payload, options)
      const [optionsError, sendOptions] = toSendOptions(normalized.options)
      if (optionsError) return [optionsError, undefined]
      const [error] = await queueProviderResult("cloudflare", "send", () => binding.send(normalized.payload, sendOptions))
      if (error) return [error, undefined]
      return [undefined, { status: "queued", messageId: normalized.id }]
    },
    async sendBatch(items, options) {
      const messages: (typeof items[number] & CloudflareSendOptions)[] = []
      for (const item of items) {
        const [optionsError, sendOptions] = toSendOptions({
          ...options,
          contentType: item.contentType || options?.contentType,
          delaySeconds: item.delaySeconds ?? options?.delaySeconds,
        })
        if (optionsError) return [optionsError, undefined]
        messages.push({ ...item, ...sendOptions })
      }
      const [error] = await queueProviderResult("cloudflare", "send-batch", () => binding.sendBatch(messages))
      if (error) return [error, undefined]
      return [undefined, items.map(() => ({ status: "queued" as const }))]
    },
    createBatchHandler: createCloudflareQueueBatchHandler,
  }
}
