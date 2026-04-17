import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import type {
  CloudflareQueueBatchErrorAction,
  CloudflareQueueBatchHandlerOptions,
  CloudflareQueueBinding,
  CloudflareQueueClient,
  CloudflareQueueMessage,
  CloudflareQueueMessageBatch,
  CloudflareQueueProviderOptions,
  CloudflareQueueSendOptions,
  QueueEnqueueOptions,
  QueueSendResult,
} from "../types.ts"

function isCloudflareQueueBinding(binding: unknown): binding is CloudflareQueueBinding {
  return Boolean(binding)
    && typeof binding === "object"
    && typeof (binding as CloudflareQueueBinding).send === "function"
    && typeof (binding as CloudflareQueueBinding).sendBatch === "function"
}

function toSendOptions(options: QueueEnqueueOptions = {}): CloudflareQueueSendOptions {
  const unsupported = [
    options.idempotencyKey !== undefined ? "idempotencyKey" : undefined,
    options.retentionSeconds !== undefined ? "retentionSeconds" : undefined,
  ].filter((item): item is string => Boolean(item))

  if (unsupported.length) {
    throw new QueueError(`Cloudflare queue does not support enqueue options: ${unsupported.join(", ")}.`, {
      code: "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS",
      details: { unsupported },
      httpStatus: 400,
      method: "send",
      provider: "cloudflare",
    })
  }

  return {
    contentType: options.contentType,
    delaySeconds: options.delaySeconds,
  }
}

function resolveAction(action: CloudflareQueueBatchErrorAction | void, message: CloudflareQueueMessage): void {
  if (action === "ack") {
    message.ack()
    return
  }

  if (action && typeof action === "object" && "retry" in action) {
    message.retry(action.retry)
    return
  }

  message.retry()
}

export function createCloudflareQueueBatchHandler<TPayload = unknown>(
  options: CloudflareQueueBatchHandlerOptions<TPayload>,
): (batch: CloudflareQueueMessageBatch<TPayload>) => Promise<void> {
  const requestedConcurrency = Number(options.concurrency ?? 1)
  const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? Math.floor(requestedConcurrency)
    : 1

  return async (batch) => {
    const messages = Array.isArray(batch?.messages) ? batch.messages : []
    if (!messages.length) return

    let index = 0
    const worker = async (): Promise<void> => {
      while (index < messages.length) {
        const message = messages[index++]!
        try {
          await options.onMessage(message, batch)
          message.ack()
        }
        catch (error) {
          resolveAction(options.onError ? await options.onError(error, message, batch) : undefined, message)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, () => worker()))
  }
}

export function createCloudflareQueueClient(provider: CloudflareQueueProviderOptions): CloudflareQueueClient {
  if (typeof provider.binding === "undefined" || typeof provider.binding === "string") {
    throw new QueueError(
      typeof provider.binding === "string"
        ? "Cloudflare queue binding names require request-scoped runtime resolution."
        : "Cloudflare queue direct clients require a binding.",
      {
        code: "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED",
        httpStatus: 400,
        provider: "cloudflare",
      },
    )
  }

  if (!isCloudflareQueueBinding(provider.binding)) {
    throw new QueueError("Invalid Cloudflare queue binding. Expected an object with send() and sendBatch().", {
      code: "CLOUDFLARE_BINDING_INVALID",
      httpStatus: 400,
      provider: "cloudflare",
    })
  }

  const binding = provider.binding

  return {
    provider: "cloudflare",
    native: binding,
    binding,
    async send(input) {
      const normalized = normalizeQueueEnqueueInput(input)
      await binding.send(normalized.payload, toSendOptions(normalized.options))
      return { status: "queued", messageId: normalized.id }
    },
    async sendBatch(items, options) {
      await binding.sendBatch(items.map(item => ({
        ...item,
        ...toSendOptions({
          ...options,
          contentType: item.contentType || options?.contentType,
          delaySeconds: item.delaySeconds ?? options?.delaySeconds,
        }),
      })))

      return items.map((_, index): QueueSendResult => ({
        status: "queued",
        messageId: `cloudflare_${index + 1}`,
      }))
    },
    createBatchHandler: createCloudflareQueueBatchHandler,
  }
}
