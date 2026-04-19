import { normalizeQueueOptions } from "../config.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel-topic.ts"
import { createCloudflareQueueClient } from "../providers/cloudflare.ts"
import { createMemoryQueueClient } from "../providers/memory.ts"
import { createVercelQueueClient as createConfiguredVercelQueueClient } from "./vercel-provider.ts"
import {
  getQueueClientCache,
  getQueueRuntimeConfig,
  getQueueRuntimeEvent,
  loadQueueDefinition,
  runWithQueueRuntimeEvent,
} from "./state.ts"

import type {
  CloudflareQueueBinding,
  InternalQueueClient,
  InternalQueueProviderOptions,
  QueueClient,
  QueueEnqueueInput,
  QueueJob,
  QueueProviderOptions,
  QueueSendResult,
  ResolvedQueueModuleOptions,
  InternalResolvedQueueModuleProviderOptions,
} from "../types.ts"

function getCloudflareEnv(event: unknown): Record<string, unknown> | undefined {
  const target = event as {
    context?: {
      cloudflare?: { env?: Record<string, unknown> }
      _platform?: { cloudflare?: { env?: Record<string, unknown> } }
    }
    env?: Record<string, unknown>
    req?: {
      context?: { cloudflare?: { env?: Record<string, unknown> } }
      runtime?: { cloudflare?: { env?: Record<string, unknown> } }
    }
    runtime?: { cloudflare?: { env?: Record<string, unknown> } }
  } | undefined

  return target?.env
    || target?.runtime?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || target?.req?.context?.cloudflare?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || (globalThis as { __env__?: Record<string, unknown> }).__env__
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
  provider: InternalResolvedQueueModuleProviderOptions,
): InternalQueueProviderOptions {
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
    signal: new AbortController().signal,
  }
}

/**
 * Create a raw queue client from explicit provider options.
 * Prefer {@link getQueue} when the queue is declared via `defineQueue`.
 */
export async function createQueueClient(options?: QueueProviderOptions): Promise<QueueClient> {
  if (!options) {
    throw new QueueError("Queue provider options are required.", {
      code: "QUEUE_PROVIDER_REQUIRED",
      httpStatus: 400,
    })
  }

  if (options.provider === "cloudflare") return createCloudflareQueueClient(options)
  return await createConfiguredVercelQueueClient(options)
}

async function createInternalQueueClient(options?: InternalQueueProviderOptions): Promise<InternalQueueClient> {
  const provider = options || { provider: "memory" as const }

  if (provider.provider === "cloudflare") return createCloudflareQueueClient(provider)
  if (provider.provider === "vercel") {
    return await createConfiguredVercelQueueClient(provider)
  }
  return createMemoryQueueClient(provider)
}

async function getNitroRequest(): Promise<unknown> {
  return getQueueRuntimeEvent()
}

function getActiveQueueConfig(): ResolvedQueueModuleOptions | false {
  const config = getQueueRuntimeConfig()
  if (config === false) return false
  return config || normalizeQueueOptions(undefined) || { provider: { provider: "memory" } }
}

async function createNamedQueueClient(name: string): Promise<InternalQueueClient> {
  const config = getActiveQueueConfig()
  if (config === false) {
    throw new QueueError("Queue is disabled.", {
      code: "QUEUE_DISABLED",
      httpStatus: 400,
    })
  }

  const build = async () => {
    try {
      return await createInternalQueueClient(applyNamedProviderDefaults(name, config.provider))
    }
    catch (error) {
      if (error instanceof QueueError) throw error
      throw new QueueError(error instanceof Error ? error.message : String(error), {
        cause: error,
        provider: config.provider.provider,
      })
    }
  }

  if (config.provider.provider === "cloudflare" && !getQueueRuntimeEvent()) {
    const request = await getNitroRequest()
    if (request) return await runWithQueueRuntimeEvent(request, build)
  }

  return await build()
}

/**
 * Resolve a queue client by declared name, caching when the provider allows it.
 * Throws `QUEUE_DEFINITION_NOT_FOUND` if no `defineQueue` registered `name`.
 */
async function getInternalQueue(name: string): Promise<InternalQueueClient> {
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

export async function getQueue(name: string): Promise<QueueClient> {
  return await getInternalQueue(name) as QueueClient
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
  const queue = await getInternalQueue(name)
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
 */
export function deferQueue<TPayload = unknown>(
  name: string,
  input: QueueEnqueueInput<TPayload>,
): void {
  void getNitroRequest().then((request) => {
    const task = () => runWithQueueRuntimeEvent(request, () => runQueue(name, input))
    const waitUntil = (request as { waitUntil?: (promise: Promise<unknown>) => void } | undefined)?.waitUntil
    if (waitUntil) {
      waitUntil(task())
      return
    }

    task().catch((error) => {
      console.error(`[vitehub] Deferred queue dispatch failed for "${name}"`, error)
    })
  })
}
