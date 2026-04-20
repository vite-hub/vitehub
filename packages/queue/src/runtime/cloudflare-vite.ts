import { createApp, toWebHandler } from "h3"

import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"

import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { CloudflareQueueMessageBatch, QueueDefinitionRegistry, ResolvedQueueModuleOptions } from "../types.ts"

export type CloudflareWorkerEnv = Record<string, unknown>

export type CloudflareWorkerExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void
}

export type CloudflareWorkerApp =
  | {
    fetch?: (request: Request, context?: Record<string, unknown>) => Response | Promise<Response>
    request?: (request: Request, options?: RequestInit, context?: Record<string, unknown>) => Response | Promise<Response>
  }
  | ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>)

export interface QueueCloudflareWorkerOptions {
  app?: CloudflareWorkerApp
  queue?: false | ResolvedQueueModuleOptions
  registry?: QueueDefinitionRegistry
}

export interface QueueCloudflareWorker {
  fetch: (request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<Response>
  queue: (batch: CloudflareQueueMessageBatch, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<void>
}

function setActiveEnv(env: CloudflareWorkerEnv) {
  ;(globalThis as { __env__?: CloudflareWorkerEnv }).__env__ = env
}

function createRuntimeEvent(env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext | undefined) {
  return {
    context: {
      cloudflare: { env },
      waitUntil: typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : undefined,
    },
    env,
    waitUntil: typeof context?.waitUntil === "function" ? context.waitUntil.bind(context) : undefined,
  }
}

function resolveQueueAppFetch(queueApp: CloudflareWorkerApp | undefined) {
  if (!queueApp) {
    return undefined
  }

  if (typeof queueApp === "function") {
    return queueApp
  }

  if (typeof queueApp.request === "function") {
    return (request: Request, context?: Record<string, unknown>) => queueApp.request!(request, undefined, context)
  }

  if (typeof queueApp.fetch === "function") {
    return queueApp.fetch.bind(queueApp)
  }

  throw new TypeError("Invalid Vite queue worker app. Expected an h3 app or a fetch-compatible handler.")
}

function createQueueJob(message: CloudflareQueueMessageBatch["messages"][number], batch: CloudflareQueueMessageBatch) {
  return {
    attempts: typeof message.attempts === "number" ? message.attempts : 1,
    id: message.id,
    metadata: {
      batch,
      message,
    },
    payload: message.body,
  }
}

export function createQueueCloudflareWorker(options: QueueCloudflareWorkerOptions = {}): QueueCloudflareWorker {
  const queueConfig = options.queue
  const registry = options.registry
  const defaultHandler = toWebHandler(createApp())
  const appHandler = resolveQueueAppFetch(options.app)

  const applyRuntimeState = () => {
    setQueueRuntimeConfig(queueConfig)
    setQueueRuntimeRegistry(registry)
  }

  return {
    async fetch(request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) {
      applyRuntimeState()
      setActiveEnv(env)
      const runtimeEvent = createRuntimeEvent(env, context)
      return await runWithQueueRuntimeEvent(runtimeEvent, () => Promise.resolve(appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context)))
    },
    async queue(batch: CloudflareQueueMessageBatch, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) {
      applyRuntimeState()
      setActiveEnv(env)
      if (queueConfig === false || queueConfig?.provider.provider !== "cloudflare") {
        return
      }

      const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue))
      if (!definition) {
        return
      }

      const runtimeEvent = createRuntimeEvent(env, context)
      await createCloudflareQueueBatchHandler({
        concurrency: definition.options?.concurrency,
        onError: definition.options?.onError,
        onMessage: async (message, currentBatch) => {
          await runWithQueueRuntimeEvent(runtimeEvent, async () => {
            await definition.handler(createQueueJob(message, currentBatch))
          })
        },
      })(batch)
    },
  }
}
