import { useRuntimeConfig } from "nitro/runtime-config"

import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"
import {
  enterQueueRuntimeEvent,
  loadQueueDefinition,
  runWithQueueRuntimeEvent,
  setQueueRuntimeConfig,
} from "./state.ts"

import type {
  CloudflareQueueMessage,
  CloudflareQueueMessageBatch,
  QueueJob,
  ResolvedQueueModuleOptions,
} from "../types.ts"

type CloudflareQueueHookPayload = {
  batch?: CloudflareQueueMessageBatch
  context?: unknown
  env?: Record<string, unknown>
  event?: CloudflareQueueMessageBatch
}

type NitroHooks = {
  hook: (
    name: string,
    handler: ((event: unknown) => void | Promise<void>) | ((payload: CloudflareQueueHookPayload) => void | Promise<void>),
  ) => void
}

type NitroAppLike = {
  hooks: NitroHooks
}

function createCloudflareQueueJob(
  message: CloudflareQueueMessage,
  batch: CloudflareQueueMessageBatch,
): QueueJob {
  return {
    attempts: typeof message.attempts === "number" ? message.attempts : 1,
    id: message.id,
    metadata: { batch, message },
    payload: message.body,
  }
}

const queueNitroPlugin = (nitroApp: NitroAppLike): void => {
  const runtimeConfig = useRuntimeConfig() as {
    queue?: false | ResolvedQueueModuleOptions
  }
  setQueueRuntimeConfig(runtimeConfig.queue)

  nitroApp.hooks.hook("request", (event: unknown) => {
    enterQueueRuntimeEvent(event)
  })

  nitroApp.hooks.hook("cloudflare:queue", async (payload: CloudflareQueueHookPayload) => {
    setQueueRuntimeConfig(runtimeConfig.queue)

    if (runtimeConfig.queue === false || runtimeConfig.queue?.provider.provider !== "cloudflare") return

    const batch = payload.batch || payload.event
    const name = batch?.queue
    if (!batch || typeof name !== "string") return

    const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(name))
    if (!definition) return

    const handler = createCloudflareQueueBatchHandler({
      concurrency: definition.options?.concurrency,
      onError: definition.options?.onError,
      onMessage: async (message, currentBatch) => {
        await runWithQueueRuntimeEvent(payload, async () => {
          await definition.handler(createCloudflareQueueJob(message, currentBatch))
        })
      },
    })

    await handler(batch)
  })
}

export default queueNitroPlugin
