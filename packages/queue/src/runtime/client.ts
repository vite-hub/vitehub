import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeQueueOptions } from "../config.ts"
import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"
import { resolveVercelQueueRegion } from "../internal/vercel-region.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import { getOrCreateQueueClient, getQueueRuntimeClientFactory, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "../internal/runtime/state.ts"

import type { Result } from "@vite-hub/runtime"
import type { CloudflareQueueClient, CloudflareQueueProviderOptions, QueueClient, QueueEnqueueOptions, QueueErrorCode, QueueName, QueuePayload, QueueProviderOptions, QueueSendResult, ResolvedQueueOptions, VercelQueueProviderOptions } from "../types.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

async function loadNamedQueueDefinition(name: string) {
  try {
    return await loadQueueDefinition(name)
  }
  catch (cause) {
    // Names can come from external input. Only a safe identifier goes into the `why`.
    throw queueErrorDiagnostics.QUEUE_DEFINITION_LOAD_FAILED({ cause, queue: normalizePublicQueueIdentifier(name) })
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

async function createNamedQueueClient(name: string): Promise<QueueClient> {
  const config = getActiveQueueConfig()
  if (config === false) {
    throw queueErrorDiagnostics.QUEUE_DISABLED()
  }

  const provider = toProviderOptions(name, config)
  const createClient = getQueueRuntimeClientFactory()
  if (!createClient) {
    throw queueErrorDiagnostics.QUEUE_RUNTIME_NOT_INSTALLED()
  }
  try {
    return await createClient(provider)
  }
  catch (cause) {
    if (isQueueError(cause)) throw cause
    throw queueErrorDiagnostics.QUEUE_PROVIDER_FAILED({ cause, operation: "create-client", provider: provider.provider })
  }
}

async function getDynamicQueue(name: string): Promise<QueueClient> {
  const definition = await loadNamedQueueDefinition(name)
  if (!definition) {
    throw queueErrorDiagnostics.QUEUE_DEFINITION_NOT_FOUND({ queue: normalizePublicQueueIdentifier(name) })
  }

  const config = getActiveQueueConfig()
  const bypassCache = definition.options?.cache === false || config === false || config.cache === false || config.provider === "cloudflare" || (config.provider === "vercel" && resolveVercelQueueRegion(config.region).requestScoped)
  if (bypassCache) {
    return await createNamedQueueClient(name)
  }

  return await getOrCreateQueueClient(name, () => createNamedQueueClient(name))
}

async function runDynamicQueue(name: string, payload: unknown, options?: QueueEnqueueOptions): Promise<Result<QueueSendResult, QueueErrorCode>> {
  let queue: QueueClient
  try {
    queue = await getDynamicQueue(name)
  }
  catch (error) {
    // A provider failure while the client starts is a runtime error. Config errors still throw.
    if (isQueueError(error, ["QUEUE_PROVIDER_FAILED"])) return [error, undefined]
    throw error
  }
  return await queue.send(payload, options)
}

function deferDynamicQueue(name: string, payload: unknown, options?: QueueEnqueueOptions): void {
  const request = getQueueRuntimeEvent()
  const task = async () => {
    const [error] = await runWithQueueRuntimeEvent(request, () => runDynamicQueue(name, payload, options))
    if (error) throw error
  }
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

/**
 * Returns the QueueClient of a discovered Queue Definition. Config errors, for example an unknown name, throw.
 */
export async function getQueue<TName extends QueueName>(name: TName): Promise<QueueClient<"cloudflare" | "vercel", QueuePayload<TName>>> {
  return await getDynamicQueue(name)
}

/**
 * Enqueues one job and returns `[error, result]`. `error.code` is a `QueueErrorCode`.
 * Config errors, for example an unknown Queue name, throw.
 */
export function runQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): Promise<Result<QueueSendResult, QueueErrorCode>> {
  return runDynamicQueue(name, payload, options)
}

export function deferQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): void {
  deferDynamicQueue(name, payload, options)
}
