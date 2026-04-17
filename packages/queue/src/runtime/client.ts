import { normalizeQueueOptions } from "../config.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel-topic.ts"
import { createCloudflareQueueClient } from "../providers/cloudflare.ts"
import { createMemoryQueueClient } from "../providers/memory.ts"
import { createVercelQueueClient } from "../providers/vercel.ts"
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
  ResolvedQueueModuleProviderOptions,
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
  provider: ResolvedQueueModuleProviderOptions,
): QueueProviderOptions & { topic?: string } {
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

function getActiveQueueConfig() {
  const config = getQueueRuntimeConfig()
  if (config === false) return false
  return config || normalizeQueueOptions(undefined)
}

function createQueueJob<TPayload>(
  normalized: ReturnType<typeof normalizeQueueEnqueueInput<TPayload>>,
  metadata?: unknown,
): QueueJob<TPayload> {
  return {
    attempts: 1,
    id: normalized.id,
    metadata,
    payload: normalized.payload,
    signal: new AbortController().signal,
  }
}

export async function createQueueClient(options?: QueueProviderOptions & { topic?: string }): Promise<QueueClient> {
  const provider = options || { provider: "memory" as const }

  if (provider.provider === "cloudflare") return createCloudflareQueueClient(provider)
  if (provider.provider === "vercel") return await createVercelQueueClient(provider)
  return createMemoryQueueClient(provider)
}

let nitroModulePromise: Promise<typeof import("nitro/runtime") | undefined> | undefined

async function getNitroRequest(): Promise<unknown> {
  nitroModulePromise ||= import("nitro/runtime").catch(() => undefined)
  const nitro = await nitroModulePromise
  return nitro?.useRequest?.()
}

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getActiveQueueConfig()
  if (!config) {
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

  if (config.provider.provider === "cloudflare" && !getQueueRuntimeEvent()) {
    const request = await getNitroRequest()
    if (request) return await runWithQueueRuntimeEvent(request, build)
  }

  return await build()
}

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
    && config?.provider.cache !== false
    && config?.provider.provider !== "cloudflare"
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
