import { createCloudflareHostedWorker } from "@vite-hub/internal/runtime/cloudflare-hosted"

import { normalizeQueueOptions } from "../config.ts"
import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { getCloudflareQueueName } from "../internal/cloudflare-resource-name.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"

import { createCloudflareRuntimeEvent, createQueueJob, runWithActiveCloudflareEnv, type CloudflareWorkerEnv, type CloudflareWorkerExecutionContext } from "./cloudflare-shared.ts"
import type { QueueApp } from "./_app.ts"
import { loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

import type { CloudflareQueueMessageBatch, QueueDefinitionRegistry, ResolvedQueueOptions } from "../types.ts"

export type CloudflareWorkerApp = QueueApp

export interface QueueCloudflareWorkerOptions {
  app?: CloudflareWorkerApp
  definitions?: Record<string, string>
  queue?: false | ResolvedQueueOptions
  registry?: QueueDefinitionRegistry
}

export interface QueueCloudflareWorker {
  fetch: (request: Request, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<Response>
  queue: (batch: CloudflareQueueMessageBatch, env: CloudflareWorkerEnv, context: CloudflareWorkerExecutionContext) => Promise<void>
}

function createRegistryDefinitionNames(registry: QueueDefinitionRegistry | undefined, namePrefix: string): Record<string, string> | undefined {
  if (!registry) return undefined
  const definitions: Record<string, string> = {}
  for (const name of Object.keys(registry)) {
    const physicalName = getCloudflareQueueName(name, namePrefix)
    if (definitions[physicalName]) {
      throw new Error(`Queue names ${JSON.stringify(definitions[physicalName])} and ${JSON.stringify(name)} collide after Cloudflare resource name derivation.`)
    }
    definitions[physicalName] = name
  }
  return definitions
}

export function createQueueCloudflareWorker(options: QueueCloudflareWorkerOptions = {}): QueueCloudflareWorker {
  const queueConfig = options.queue === false ? false : normalizeQueueOptions(options.queue, { hosting: "cloudflare" })!
  const registry = options.registry
  const definitions = options.definitions
  const registryDefinitions = !definitions && queueConfig !== false && queueConfig.provider === "cloudflare"
    ? createRegistryDefinitionNames(registry, queueConfig.namePrefix ?? "")
    : undefined

  const applyRuntimeState = () => {
    setQueueRuntimeConfig(queueConfig)
    setQueueRuntimeRegistry(registry)
  }

  return {
    ...createCloudflareHostedWorker({
      app: options.app,
      label: "queue",
      async onRequest({ env, executionContext, handle }) {
        applyRuntimeState()
        const runtimeEvent = createCloudflareRuntimeEvent(env, executionContext)
        return await runWithActiveCloudflareEnv(env, () => runWithQueueRuntimeEvent(runtimeEvent, () => handle(runtimeEvent.context)))
      },
    }),
    async queue(batch, env, context) {
      applyRuntimeState()
      if (queueConfig === false || queueConfig?.provider !== "cloudflare") {
        return
      }

      const runtimeEvent = createCloudflareRuntimeEvent(env, context)
      await runWithActiveCloudflareEnv(env, async () => {
        const definitionName = definitions
          ? definitions[batch.queue]
          : registryDefinitions?.[batch.queue]
            ?? (/-[0-9a-f]{32}$/.test(batch.queue)
            && !/(?:^|-)queue--(?:[0-9a-f]{2})+$/i.test(batch.queue)
            || (queueConfig.namePrefix && !batch.queue.startsWith(queueConfig.namePrefix))
            ? undefined
            : getCloudflareQueueDefinitionName(batch.queue, queueConfig.namePrefix))
        if (!definitionName) {
          throw new Error(`[vitehub] Cloudflare queue ${JSON.stringify(batch.queue)} is not mapped to a Queue Definition.`)
        }
        const definition = await loadQueueDefinition(definitionName)
        if (!definition) {
          throw new Error(`[vitehub] Cloudflare queue ${JSON.stringify(batch.queue)} maps to unknown Queue Definition ${JSON.stringify(definitionName)}.`)
        }

        await createCloudflareQueueBatchHandler({
          concurrency: definition.options?.concurrency,
          onError: definition.options?.onError,
          onMessage: async (message, currentBatch) => {
            await runWithQueueRuntimeEvent(runtimeEvent, async () => {
              await definition.handler(createQueueJob(message, currentBatch))
            })
          },
        })(batch)
      })
    },
  }
}
