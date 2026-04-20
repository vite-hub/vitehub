import { normalizeQueueOptions } from "../config.ts"
import { normalizeQueueEnqueueInput } from "../enqueue.ts"
import { QueueError } from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"
import { createCloudflareQueueClient } from "../providers/cloudflare.ts"
import { createVercelQueueClient } from "../providers/vercel.ts"

import { getQueueClientCache, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "./state.ts"

import type { CloudflareQueueClient, CloudflareQueueProviderOptions, QueueClient, QueueEnqueueInput, QueueJob, QueueProviderOptions, QueueSendResult, ResolvedQueueModuleOptions, VercelQueueProviderOptions } from "../types.ts"

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
  if (!resolved) {
    return bindingName
  }

  return resolved
}

function applyNamedProviderDefaults(name: string, provider: QueueProviderOptions): QueueProviderOptions {
  if (provider.provider === "cloudflare") {
    return {
      ...provider,
      binding: resolveCloudflareBinding(provider.binding, name),
    } satisfies CloudflareQueueProviderOptions
  }

  return {
    ...provider,
    topic: provider.topic || getVercelQueueTopicName(name),
  } satisfies VercelQueueProviderOptions
}

function createQueueJob<TPayload = unknown>(normalized: { id: string, payload: TPayload }): QueueJob<TPayload> {
  return {
    attempts: 1,
    id: normalized.id,
    payload: normalized.payload,
  }
}

export async function createQueueClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider === "cloudflare") {
    return createCloudflareQueueClient(options)
  }

  return await createVercelQueueClient(options)
}

function getActiveQueueConfig(): false | ResolvedQueueModuleOptions {
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

  const provider = applyNamedProviderDefaults(name, config.provider)
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

  const cache = getQueueClientCache()
  const config = getActiveQueueConfig()
  if (definition.options?.cache === false || config === false || config.provider.cache === false || config.provider.provider === "cloudflare") {
    return await createNamedQueueClient(name)
  }

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
  const result = await queue.send({
    ...normalized.options,
    id: normalized.id,
    payload: normalized.payload,
  })

  return result
}

export function deferQueue<TPayload = unknown>(name: string, input: QueueEnqueueInput<TPayload>): void {
  const request = getQueueRuntimeEvent() as { waitUntil?: (promise: Promise<unknown>) => void } | undefined
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
  if (typeof request?.waitUntil === "function") {
    request.waitUntil(promise)
  }
}
