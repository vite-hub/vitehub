import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { normalizeQueueOptions } from "../config.ts"
import { isQueueError, normalizePublicQueueIdentifier } from "../errors.ts"
import { resolveVercelQueueRegion } from "../internal/vercel-region.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"

import { createTestQueueClient } from "./test-client.ts"
import { getOrCreateQueueClient, getQueueRuntimeClientFactory, getQueueRuntimeConfig, getQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent } from "../internal/runtime/state.ts"

import type { Result } from "@vite-hub/runtime"
import type { CloudflareQueueClient, CloudflareQueueProviderOptions, LocalQueueProviderOptions, PostgresQueueProviderOptions, QueueClient, QueueEnqueueOptions, QueueErrorCode, QueueName, QueuePayload, QueueProvider, QueueSendResult, VercelQueueProviderOptions } from "../types.ts"
import type { QueueRuntimeOptions, QueueRuntimeProviderOptions } from "../internal/runtime/types.ts"
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

function toProviderOptions(name: string, config: QueueRuntimeOptions): QueueRuntimeProviderOptions {
  if (config.provider === "cloudflare") {
    return {
      ...config,
      binding: resolveCloudflareBinding(config.binding, name),
    } satisfies CloudflareQueueProviderOptions
  }

  if (config.provider === "local") {
    return { ...config, queue: name } satisfies LocalQueueProviderOptions
  }

  if (config.provider === "postgres") {
    return { ...config, queue: name } satisfies PostgresQueueProviderOptions
  }

  return {
    ...config,
    topic: getVercelQueueTopicName(name),
  } satisfies VercelQueueProviderOptions
}

function getActiveQueueConfig(): false | QueueRuntimeOptions {
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

async function useDynamicQueue(name: string): Promise<QueueClient> {
  // A disabled Queue loads no definitions, so say so first: QUEUE_DEFINITION_NOT_FOUND
  // would tell the developer to add a queue file that already exists.
  const config = getActiveQueueConfig()
  if (config === false) {
    throw queueErrorDiagnostics.QUEUE_DISABLED()
  }

  const definition = await loadNamedQueueDefinition(name)
  if (!definition) {
    throw queueErrorDiagnostics.QUEUE_DEFINITION_NOT_FOUND({ queue: normalizePublicQueueIdentifier(name) })
  }

  const test = getViteHubTestMode()
  if (test) return createTestQueueClient(test, name, config.provider === "local" ? config.rules ?? "local" : config.provider)

  const bypassCache = definition.options?.cache === false || config.cache === false || config.provider === "cloudflare" || (config.provider === "vercel" && resolveVercelQueueRegion(config.region).requestScoped)
  if (bypassCache) {
    return await createNamedQueueClient(name)
  }

  return await getOrCreateQueueClient(name, () => createNamedQueueClient(name))
}

async function sendDynamicQueue(name: string, payload: unknown, options?: QueueEnqueueOptions): Promise<Result<QueueSendResult, QueueErrorCode>> {
  let queue: QueueClient
  try {
    queue = await useDynamicQueue(name)
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
    const [error] = await runWithQueueRuntimeEvent(request, () => sendDynamicQueue(name, payload, options))
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
  send: typeof sendDynamicQueue
  use: typeof useDynamicQueue
} = {
  defer: deferDynamicQueue,
  send: sendDynamicQueue,
  use: useDynamicQueue,
}

/**
 * Returns the QueueClient of a discovered Queue Definition, for `sendBatch()` and provider methods. Config errors, for example an unknown name, throw.
 */
export async function useQueue<TName extends QueueName>(name: TName): Promise<QueueClient<QueueProvider, QueuePayload<TName>>> {
  return await useDynamicQueue(name)
}

/**
 * Sends one job to the Queue and returns `[error, result]`. `error.code` is a `QueueErrorCode`.
 * Config errors, for example an unknown Queue name, throw.
 */
export function sendQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): Promise<Result<QueueSendResult, QueueErrorCode>> {
  return sendDynamicQueue(name, payload, options)
}

/**
 * Sends one job after the response, through `waitUntil`. It returns nothing: a failure goes to the log and to the
 * `onDispatchError` option of the Queue Definition. Call `sendQueue()` when the caller needs the message ID.
 */
export function deferQueue<TName extends QueueName>(name: TName, payload: NoInfer<QueuePayload<TName>>, options?: QueueEnqueueOptions): void {
  deferDynamicQueue(name, payload, options)
}
