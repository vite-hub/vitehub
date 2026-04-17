import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareEnv } from "../internal/cloudflare-env.ts"
import { createCloudflareQueueClient, getCloudflareQueueBindingName } from "../providers/cloudflare.ts"
import { createMemoryQueueClient } from "../providers/memory.ts"
import { createVercelQueueClient } from "../providers/vercel.ts"
import {
  getQueueClientCache,
  getQueueRuntimeConfig,
  getQueueRuntimeEvent,
  loadQueueDefinition,
  setQueueRuntimeEvent,
} from "./state.ts"

import type {
  CloudflareQueueBinding,
  QueueClient,
  QueueEnqueueInput,
  QueueProviderOptions,
  QueueSendResult,
} from "../types.ts"

function resolveCloudflareBinding(binding: string | CloudflareQueueBinding | undefined, name: string): string | CloudflareQueueBinding {
  if (binding && typeof binding !== "string") return binding

  const bindingName = binding || getCloudflareQueueBindingName(name)
  const env = getCloudflareEnv(getQueueRuntimeEvent())
  const resolved = env?.[bindingName]

  if (!resolved) return bindingName
  return resolved as CloudflareQueueBinding
}

function applyNamedProviderDefaults(name: string, provider: QueueProviderOptions): QueueProviderOptions {
  if (provider.provider === "cloudflare") return { ...provider, binding: resolveCloudflareBinding(provider.binding, name) }
  if (provider.provider === "vercel") return { ...provider, topic: name }
  return provider
}

export async function createQueueClient(options?: QueueProviderOptions): Promise<QueueClient> {
  const provider = options || { provider: "memory" as const }

  if (provider.provider === "cloudflare") return createCloudflareQueueClient(provider)
  if (provider.provider === "vercel") return await createVercelQueueClient(provider)
  return createMemoryQueueClient(provider)
}

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getQueueRuntimeConfig() ?? { provider: { provider: "memory" as const } }
  if (config === false) {
    throw new QueueError("Queue is disabled.", {
      code: "QUEUE_DISABLED",
      httpStatus: 400,
    })
  }

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

export async function getQueue(name: string): Promise<QueueClient> {
  const definition = await loadQueueDefinition(name)
  if (!definition) {
    throw new QueueError(`Unknown queue definition: ${name}`, {
      code: "QUEUE_DEFINITION_NOT_FOUND",
      details: { name },
      httpStatus: 404,
    })
  }

  const cache = getQueueClientCache()
  const cacheEnabled = definition.options?.cache !== false
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
    Promise.resolve().then(() => definition.handler({
      attempts: 1,
      id: normalized.id,
      payload: normalized.payload,
      signal: new AbortController().signal,
    }))
      .catch((error) => {
        console.error(`[vitehub] Memory queue handler failed for "${name}"`, error)
      })
  }

  return result
}

let nitroModulePromise: Promise<typeof import("nitro/runtime") | undefined> | undefined

async function getNitroRequest(): Promise<unknown> {
  nitroModulePromise ||= import("nitro/runtime").catch(() => undefined)
  const nitro = await nitroModulePromise
  return nitro?.useRequest?.()
}

export function deferQueue<TPayload = unknown>(
  name: string,
  input: QueueEnqueueInput<TPayload>,
): void {
  void getNitroRequest().then((request) => {
    const task = async () => {
      if (request) setQueueRuntimeEvent(request)
      await runQueue(name, input)
    }

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
