import { H3, toWebHandler } from "h3"

import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"

import { createCloudflareRuntimeEvent, createQueueJob, setActiveCloudflareEnv, type CloudflareWorkerEnv, type CloudflareWorkerExecutionContext } from "./cloudflare-shared.ts"
import { resolveQueueAppFetch, type QueueApp } from "./_app.ts"
import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { CloudflareQueueMessageBatch, QueueDefinitionRegistry, ResolvedQueueOptions } from "../types.ts"

export type CloudflareWorkerApp = QueueApp

export interface QueueCloudflareWorkerOptions {
  app?: CloudflareWorkerApp
  queue?: false | ResolvedQueueOptions
  registry?: QueueDefinitionRegistry
}

export interface QueueCloudflareWorker {
  fetch: (request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<Response>
  queue: (batch: CloudflareQueueMessageBatch, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<void>
}

export function createQueueCloudflareWorker(options: QueueCloudflareWorkerOptions = {}): QueueCloudflareWorker {
  const queueConfig = options.queue
  const registry = options.registry
  const defaultHandler = toWebHandler(new H3())
  const appHandler = resolveQueueAppFetch(options.app)

  const applyRuntimeState = () => {
    setQueueRuntimeConfig(queueConfig)
    setQueueRuntimeRegistry(registry)
  }

  return {
    async fetch(request, env, context) {
      applyRuntimeState()
      setActiveCloudflareEnv(env)
      const runtimeEvent = createCloudflareRuntimeEvent(env, context)
      return await runWithQueueRuntimeEvent(runtimeEvent, () => Promise.resolve(appHandler ? appHandler(request, runtimeEvent.context) : defaultHandler(request, runtimeEvent.context)))
    },
    async queue(batch, env, context) {
      applyRuntimeState()
      setActiveCloudflareEnv(env)
      if (queueConfig === false || queueConfig?.provider !== "cloudflare") {
        return
      }

      const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue))
      if (!definition) {
        return
      }

      const runtimeEvent = createCloudflareRuntimeEvent(env, context)
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
