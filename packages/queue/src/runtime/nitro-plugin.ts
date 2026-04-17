import { defineNitroPlugin, useRuntimeConfig } from "nitro/runtime"

import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"
import {
  loadQueueDefinition,
  setQueueRuntimeConfig,
  setQueueRuntimeEvent,
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

function createCloudflareQueueJob(
  message: CloudflareQueueMessage,
  batch: CloudflareQueueMessageBatch,
): QueueJob {
  return {
    attempts: typeof message.attempts === "number" ? message.attempts : 1,
    id: message.id,
    metadata: { batch, message },
    payload: message.body,
    signal: new AbortController().signal,
  }
}

const queueNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  const runtimeConfig = useRuntimeConfig() as {
    queue?: false | ResolvedQueueModuleOptions
  }
  setQueueRuntimeConfig(runtimeConfig.queue)

  nitroApp.hooks.hook("request", (event) => {
    setQueueRuntimeEvent(event)
  })

  const hook = nitroApp.hooks.hook as unknown as (
    name: string,
    handler: (payload: CloudflareQueueHookPayload) => void | Promise<void>,
  ) => void

  hook("cloudflare:queue", async (payload: CloudflareQueueHookPayload) => {
    setQueueRuntimeEvent(payload)
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
        await definition.handler(createCloudflareQueueJob(message, currentBatch))
      },
    })

    await handler(batch)
  })
})

export default queueNitroPlugin
