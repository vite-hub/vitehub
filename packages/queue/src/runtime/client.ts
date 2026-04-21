import { normalizeQueueOptions } from "../config.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import { getQueueClientCache, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "./state.ts"

import type { CloudflareQueueClient, CloudflareQueueProviderOptions, QueueClient, QueueEnqueueInput, QueueProviderOptions, QueueSendResult, ResolvedQueueOptions, VercelQueueProviderOptions } from "../types.ts"

function getCloudflareEnv(event: unknown) {
  const target = event as {
    context?: { cloudflare?: { env?: Record<string, unknown> }, _platform?: { cloudflare?: { env?: Record<string, unknown> } } }
    env?: Record<string, unknown>
    req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
  } | undefined
  return target?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || (globalThis as { __env__?: Record<string, unknown> }).__env__
}

function resolveCloudflareBinding(binding: string | CloudflareQueueClient["binding"] | undefined, name: string) {
  if (binding && typeof binding !== "string") {
    return binding
  }

  const bindingName = binding || getCloudflareQueueBindingName(name)
  const resolved = getCloudflareEnv(getQueueRuntimeEvent())?.[bindingName] as CloudflareQueueClient["binding"] | undefined
  return resolved || bindingName
}

function resolveWaitUntil(event: unknown): ((promise: Promise<unknown>) => void) | undefined {
  const target = event as {
    waitUntil?: (promise: Promise<unknown>) => void
    context?: {
      waitUntil?: (promise: Promise<unknown>) => void
      cloudflare?: {
        context?: { waitUntil?: (promise: Promise<unknown>) => void }
        waitUntil?: (promise: Promise<unknown>) => void
      }
      _platform?: {
        cloudflare?: {
          context?: { waitUntil?: (promise: Promise<unknown>) => void }
          waitUntil?: (promise: Promise<unknown>) => void
        }
      }
    }
    req?: {
      runtime?: {
        cloudflare?: {
          context?: { waitUntil?: (promise: Promise<unknown>) => void }
          waitUntil?: (promise: Promise<unknown>) => void
        }
      }
    }
  } | undefined

  return target?.waitUntil
    || target?.context?.waitUntil
    || target?.context?.cloudflare?.waitUntil
    || target?.context?.cloudflare?.context?.waitUntil
    || target?.context?._platform?.cloudflare?.waitUntil
    || target?.context?._platform?.cloudflare?.context?.waitUntil
    || target?.req?.runtime?.cloudflare?.waitUntil
    || target?.req?.runtime?.cloudflare?.context?.waitUntil
}

function toProviderOptions(name: string, config: ResolvedQueueOptions): QueueProviderOptions {
  if (config.provider === "cloudflare") {
    return {
      ...config,
      binding: resolveCloudflareBinding(config.binding, name),
    } satisfies CloudflareQueueProviderOptions
  }

  return {
    ...config,
    topic: getVercelQueueTopicName(name),
  } satisfies VercelQueueProviderOptions
}

export async function createQueueClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider === "cloudflare") {
    const { createCloudflareQueueClient } = await import("../providers/cloudflare.ts")
    return createCloudflareQueueClient(options)
  }

  const { createVercelQueueClient } = await import("../providers/vercel.ts")
  return await createVercelQueueClient(options)
}

function getActiveQueueConfig(): false | ResolvedQueueOptions {
  const config = getQueueRuntimeConfig()
  if (config === false) {
    return false
  }

  return config || normalizeQueueOptions(undefined, { hosting: "vercel" })!
}

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getActiveQueueConfig()
  if (config === false) {
    throw new QueueError("Queue is disabled.", {
      code: "QUEUE_DISABLED",
      httpStatus: 400,
    })
  }

  const provider = toProviderOptions(name, config)
  try {
    return await createQueueClient(provider)
  } catch (error) {
    if (error instanceof QueueError) {
      throw error
    }

    throw new QueueError(error instanceof Error ? error.message : String(error), {
      cause: error,
      provider: provider.provider,
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

  const config = getActiveQueueConfig()
  const bypassCache = definition.options?.cache === false || config === false || config.cache === false || config.provider === "cloudflare"
  if (bypassCache) {
    return await createNamedQueueClient(name)
  }

  const cache = getQueueClientCache()
  const existing = cache.get(name)
  if (existing) {
    return await existing as QueueClient
  }

  const pending = createNamedQueueClient(name).catch((error) => {
    cache.delete(name)
    throw error
  })

  cache.set(name, pending)
  return await pending
}

export async function runQueue<TPayload = unknown>(name: string, input: QueueEnqueueInput<TPayload>): Promise<QueueSendResult> {
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
  return await queue.send({
    ...normalized.options,
    id: normalized.id,
    payload: normalized.payload,
  })
}

export function deferQueue<TPayload = unknown>(name: string, input: QueueEnqueueInput<TPayload>): void {
  const request = getQueueRuntimeEvent()
  const task = () => runWithQueueRuntimeEvent(request, () => runQueue(name, input))
  const handleError = async (error: unknown) => {
    console.error(`[vitehub] Deferred queue dispatch failed for "${name}"`, error)
    try {
      await (await loadQueueDefinition(name))?.options?.onDispatchError?.(error, { name })
    } catch (hookError) {
      console.error(`[vitehub] onDispatchError hook failed for "${name}"`, hookError)
    }
  }

  const promise = task().catch(handleError)
  const waitUntil = resolveWaitUntil(request)
  if (typeof waitUntil === "function") {
    waitUntil(promise)
  }
}
