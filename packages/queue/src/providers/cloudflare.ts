import { readQueueTimes } from "../duration.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { normalizePublicQueueIdentifier, queueProviderResult, queueRemovedOptionsError, queueUnsupportedOptionsError } from "../errors.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"
import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { isNonRetryableQueueError, reportQueueDeliveryError } from "../internal/delivery-error.ts"
import { checkQueueHandlerResponse } from "../internal/handler-response.ts"

import { parseDuration } from "@vite-hub/runtime"

import type { Result } from "@vite-hub/runtime"

import type { CloudflareQueueBatchErrorAction, CloudflareQueueBatchHandlerOptions, CloudflareQueueBinding, CloudflareQueueClient, CloudflareQueueMessage, CloudflareQueueMessageBatch, CloudflareQueueDriverOptions, QueueEnqueueOptions } from "../types.ts"

interface CloudflareSendOptions {
  contentType?: QueueEnqueueOptions["contentType"]
  delaySeconds?: number
}

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

function toSendOptions(options: QueueEnqueueOptions = {}): Result<CloudflareSendOptions, "QUEUE_UNSUPPORTED_OPTION" | "RUNTIME_DURATION_INVALID"> {
  const error = queueUnsupportedOptionsError(options, "cloudflare")
  if (error) return [error, undefined]
  const [timeError, times] = readQueueTimes(options, "ceil")
  if (timeError) return [timeError, undefined]

  return [undefined, {
    contentType: options.contentType,
    delaySeconds: times.delaySeconds,
  }]
}

function resolveAction(action: CloudflareQueueBatchErrorAction | void, message: CloudflareQueueMessage, fallback: "ack" | "retry") {
  if (action && typeof action === "object" && !Array.isArray(action) && Object.hasOwn(action, "retry")) {
    const removed = queueRemovedOptionsError("cloudflare", action.retry)
    if (removed) throw removed
    const delay = action.retry?.delay
    message.retry(delay === undefined ? undefined : { delaySeconds: Math.ceil(parseDuration(delay, "delay", undefined, "s") / 1000) })
    return
  }

  const resolvedAction = action === "ack" || action === "retry" ? action : fallback
  if (resolvedAction === "ack") {
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
          checkQueueHandlerResponse(await options.onMessage(message, batch))
          message.ack()
        } catch (error) {
          const reportContext = {
            attempts: message.attempts,
            id: message.id,
            provider: "cloudflare",
            queue: normalizePublicQueueIdentifier(options.queue) ?? normalizePublicQueueIdentifier(getCloudflareQueueDefinitionName(batch.queue)) ?? batch.queue,
          } as const
          reportQueueDeliveryError(error, reportContext)
          let action: CloudflareQueueBatchErrorAction | void = undefined
          if (options.onError) {
            try {
              action = await options.onError(error, message, batch)
            }
            catch (hookError) {
              reportQueueDeliveryError(hookError, reportContext)
            }
          }
          try {
            resolveAction(action, message, isNonRetryableQueueError(error) ? "ack" : "retry")
          }
          catch (actionError) {
            reportQueueDeliveryError(actionError, reportContext)
            message.retry()
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()))
  }
}

export function createCloudflareQueueClient(provider: CloudflareQueueDriverOptions): CloudflareQueueClient {
  if (typeof provider.binding === "undefined" || typeof provider.binding === "string") {
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
      return [undefined, { status: "queued" }]
    },
    async sendBatch(items, options) {
      const removed = queueRemovedOptionsError("cloudflare", options, items)
      if (removed) return [removed, undefined]
      const messages: ({ body: unknown } & CloudflareSendOptions)[] = []
      for (const item of items) {
        const [optionsError, sendOptions] = toSendOptions({
          ...options,
          contentType: item.contentType || options?.contentType,
          delay: item.delay ?? options?.delay,
        })
        if (optionsError) return [optionsError, undefined]
        messages.push({ body: item.body, ...sendOptions })
      }
      const [error] = await queueProviderResult("cloudflare", "send-batch", () => binding.sendBatch(messages))
      if (error) return [error, undefined]
      return [undefined, messages.map(() => ({ status: "queued" as const }))]
    },
    createBatchHandler: createCloudflareQueueBatchHandler,
  }
}
