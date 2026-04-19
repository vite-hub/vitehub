import { normalizeQueueOptions } from "../config.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel-topic.ts"
import { createCloudflareQueueClient } from "../providers/cloudflare.ts"
import { createMemoryQueueClient } from "../providers/memory.ts"
import { createVercelQueueClient as createConfiguredVercelQueueClient } from "#vitehub-queue-vercel-provider"
import {
  getQueueClientCache,
  getQueueRuntimeConfig,
  getQueueRuntimeEvent,
  loadQueueDefinition,
  runWithQueueRuntimeEvent,
} from "./state.ts"

import type {
  CloudflareQueueBinding,
  QueueClient,
  QueueEnqueueInput,
  QueueJob,
  QueueProviderOptions,
  QueueSendResult,
  ResolvedQueueModuleOptions,
  ResolvedQueueModuleProviderOptions,
} from "../types.ts"

function getCloudflareEnv(event: unknown): Record<string, unknown> | undefined {
  type Env = Record<string, unknown>
  const target = event as {
    context?: { cloudflare?: Env & { env?: Env }, _platform?: { cloudflare?: { env?: Env } } }
    env?: Env
    req?: { runtime?: { cloudflare?: { env?: Env } } }
  } | undefined
  const context = target?.context
  return target?.env
    || context?.cloudflare?.env
    || context?._platform?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || context?.cloudflare
    || (globalThis as { __env__?: Env }).__env__
}

function resolveCloudflareBinding(
  binding: string | CloudflareQueueBinding | undefined,
  name: string,
): string | CloudflareQueueBinding {
  if (binding && typeof binding !== "string") return binding

  const bindingName = binding || getCloudflareQueueBindingName(name)
  const resolved = getCloudflareEnv(getQueueRuntimeEvent())?.[bindingName]

  if (!resolved) return bindingName
  return resolved as CloudflareQueueBinding
}

function applyNamedProviderDefaults(
  name: string,
  provider: ResolvedQueueModuleProviderOptions,
): QueueProviderOptions {
  if (provider.provider === "cloudflare") {
    return {
      ...provider,
      binding: resolveCloudflareBinding(provider.binding, name),
    }
  }

  if (provider.provider === "vercel") {
    return {
      ...provider,
      topic: getVercelQueueTopicName(name),
    }
  }

  return provider
}

function createQueueJob<TPayload>(
  normalized: ReturnType<typeof normalizeQueueEnqueueInput<TPayload>>,
): QueueJob<TPayload> {
  return {
    attempts: 1,
    id: normalized.id,
    payload: normalized.payload,
  }
}

/**
 * Create a raw queue client from explicit provider options.
 * Prefer {@link getQueue} when the queue is declared via `defineQueue`.
 */
export async function createQueueClient(options?: QueueProviderOptions): Promise<QueueClient> {
  const provider = options || { provider: "memory" as const }

  if (provider.provider === "cloudflare") return createCloudflareQueueClient(provider)
  if (provider.provider === "vercel") {
    return await createConfiguredVercelQueueClient(provider)
  }
  return createMemoryQueueClient(provider)
}

function getActiveQueueConfig(): ResolvedQueueModuleOptions | false {
  const config = getQueueRuntimeConfig()
  if (config === false) return false
  return config || normalizeQueueOptions(undefined) || { provider: { provider: "memory" } }
}

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getActiveQueueConfig()
  if (config === false) {
    throw new QueueError("Queue is disabled.", {
      code: "QUEUE_DISABLED",
      httpStatus: 400,
    })
  }

  const build = async () => {
    try {
      return await createQueueClient(applyNamedProviderDefaults(name, config.provider))
    }
    catch (error) {
      if (error instanceof QueueError) throw error
      throw new QueueError(error instanceof Error ? error.message : String(error), {
        cause: error,
        provider: config.provider.provider,
      })
    }
  }

  return await build()
}

/**
 * Resolve a queue client by declared name, caching when the provider allows it.
 * Throws `QUEUE_DEFINITION_NOT_FOUND` if no `defineQueue` registered `name`.
 */
export async function getQueue(name: string): Promise<QueueClient> {
  const definition = await loadQueueDefinition(name)
  if (!definition) {
    throw new QueueError(`Unknown queue definition: ${name}`, {
      code: "QUEUE_DEFINITION_NOT_FOUND",
      details: { name },
      httpStatus: 404,
    })
  }

  const config = getActiveQueueConfig()
  const cache = getQueueClientCache()
  const cacheEnabled = definition.options?.cache !== false
    && config !== false
    && config.provider.cache !== false
    && config.provider.provider !== "cloudflare"
  if (!cacheEnabled) return await createNamedQueueClient(name)

  const existing = cache.get(name)
  if (existing) return await existing

  const pending = createNamedQueueClient(name).catch((error: unknown) => {
    cache.delete(name)
    throw error
  })
  cache.set(name, pending)
  return await pending
}

/**
 * Enqueue a message on a named queue and, for the memory provider, run the
 * declared handler in the background.
 */
export async function runQueue<TPayload = unknown>(
  name: string,
  input: QueueEnqueueInput<TPayload>,
): Promise<QueueSendResult> {
  const definition = await loadQueueDefinition(name)
  if (!definition) {
    throw new QueueError(`Unknown queue definition: ${name}`, {
      code: "QUEUE_DEFINITION_NOT_FOUND",
      details: { name },
      httpStatus: 404,
    })
  }

  const normalized = normalizeQueueEnqueueInput(input)
  const queue = await getQueue(name)
  const result = await queue.send({
    ...normalized.options,
    id: normalized.id,
    payload: normalized.payload,
  })

  if (queue.provider === "memory") {
    queue.consume(normalized.id, { latest: true })
    Promise.resolve().then(() => definition.handler(createQueueJob(normalized)))
      .catch((error) => {
        console.error(`[vitehub] Memory queue handler failed for "${name}"`, error)
      })
  }

  return result
}

/**
 * Fire-and-forget enqueue. On Cloudflare/Vercel the dispatch is handed to the
 * request's `waitUntil` so the response returns before the queue call settles.
 * Errors are reported to the declared queue's `onError` hook (if any) and
 * always logged to the console.
 */
export function deferQueue<TPayload = unknown>(
  name: string,
  input: QueueEnqueueInput<TPayload>,
): void {
  const request = getQueueRuntimeEvent()
  const task = () => runWithQueueRuntimeEvent(request, () => runQueue(name, input))
  const handleError = async (error: unknown) => {
    console.error(`[vitehub] Deferred queue dispatch failed for "${name}"`, error)
    try {
      const definition = await loadQueueDefinition(name)
      await definition?.options?.onDispatchError?.(error, { name })
    }
    catch (hookError) {
      console.error(`[vitehub] onDispatchError hook failed for "${name}"`, hookError)
    }
  }

  const waitUntil = (request as { waitUntil?: (promise: Promise<unknown>) => void } | undefined)?.waitUntil
  const promise = task().catch(handleError)
  if (waitUntil) waitUntil(promise)
}
