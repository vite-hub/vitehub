import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeQueueOptions } from "../config.ts"
import {
  createQueueError,
  isQueueBoundaryIdentity,
  normalizePublicQueueIdentifier,
  runQueueProviderOperation,
} from "../errors.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import { getQueueClientCache, getQueueRuntimeClientFactory, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "../internal/runtime/state.ts"

import type { CloudflareQueueClient, CloudflareQueueProviderOptions, QueueClient, QueueEnqueueOptions, QueueName, QueuePayload, QueueProviderOptions, QueueSendResult, ResolvedQueueOptions, VercelQueueProviderOptions } from "../types.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

function createQueueDefinitionNotFoundError(name: string) {
  const queue = normalizePublicQueueIdentifier(name)
  return createQueueError("QUEUE_DEFINITION_NOT_FOUND", {
    details: queue ? { queue } : undefined,
  })
}

async function loadNamedQueueDefinition(name: string) {
  try {
    return await loadQueueDefinition(name)
  }
  catch (cause) {
    if (isQueueBoundaryIdentity(cause)) throw cause
    const queue = normalizePublicQueueIdentifier(name)
    throw createQueueError("QUEUE_DEFINITION_LOAD_FAILED", {
      cause,
      details: queue ? { queue } : undefined,
    })
  }
}

function resolveCloudflareBinding(binding: string | CloudflareQueueClient["binding"] | undefined, name: string) {
  if (binding && typeof binding !== "string") {
    return binding
  }

  const bindingName = binding || getCloudflareQueueBindingName(name)
  const resolved = getCloudflareEnv(getQueueRuntimeEvent())?.[bindingName] as CloudflareQueueClient["binding"] | undefined
  return resolved || bindingName
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

function getActiveQueueConfig(): false | ResolvedQueueOptions {
  const config = getQueueRuntimeConfig()
  if (config === false) {
    return false
  }

  return config || normalizeQueueOptions(undefined, { hosting: "vercel" })!
}

function hasRequestScopedVercelRegion(config: ResolvedQueueOptions): boolean {
  return config.provider === "vercel"
    && !config.region
    && !process.env.QUEUE_REGION
    && !process.env.VERCEL_REGION
    && typeof getQueueRuntimeEvent() !== "undefined"
}

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getActiveQueueConfig()
  if (config === false) {
    throw createQueueError("QUEUE_DISABLED")
  }

  const provider = toProviderOptions(name, config)
  const createClient = getQueueRuntimeClientFactory()
  if (!createClient) {
    throw queueErrorDiagnostics.QUEUE_R0012({ message: "[vitehub] Queue Client is installed by generated Provider Output." })
  }
  return await runQueueProviderOperation(provider.provider, "create-client", () => createClient(provider))
}

async function getDynamicQueue(name: string): Promise<QueueClient> {
  const definition = await loadNamedQueueDefinition(name)
  if (!definition) {
    throw createQueueDefinitionNotFoundError(name)
  }

  const config = getActiveQueueConfig()
  const bypassCache = definition.options?.cache === false || config === false || config.cache === false || config.provider === "cloudflare" || hasRequestScopedVercelRegion(config)
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

async function runDynamicQueue(name: string, payload: unknown, options?: QueueEnqueueOptions): Promise<QueueSendResult> {
  const queue = await getDynamicQueue(name)
  return await queue.send(payload, options)
}

function deferDynamicQueue(name: string, payload: unknown, options?: QueueEnqueueOptions): void {
  const request = getQueueRuntimeEvent()
  const task = () => runWithQueueRuntimeEvent(request, () => runDynamicQueue(name, payload, options))
  const handleError = async (error: unknown) => {
    console.error(`[vitehub] Deferred queue dispatch failed for "${name}"`, error)
    try {
      await (await loadNamedQueueDefinition(name))?.options?.onDispatchError?.(error, { name })
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

/** Dispatch externally supplied names and payloads after application validation. */
export const dynamicQueue: {
  defer: typeof deferDynamicQueue
  get: typeof getDynamicQueue
  run: typeof runDynamicQueue
} = {
  defer: deferDynamicQueue,
  get: getDynamicQueue,
  run: runDynamicQueue,
}

export async function getQueue<TName extends QueueName>(name: TName): Promise<QueueClient<"cloudflare" | "vercel", QueuePayload<TName>>> {
  return await getDynamicQueue(name)
}

export function runQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): Promise<QueueSendResult> {
  return runDynamicQueue(name, payload, options)
}

export function deferQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): void {
  deferDynamicQueue(name, payload, options)
}
