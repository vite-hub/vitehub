import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { getCloudflareQueueDefinitionName } from "../integrations/cloudflare.ts"
import { createCloudflareQueueBatchHandler } from "../providers/cloudflare.ts"
import type { CloudflareQueueMessageBatch, ResolvedQueueOptions } from "../types.ts"

import queueRegistry from "#vitehub/queue/registry"
import { createCloudflareRuntimeEvent, createQueueJob, setActiveCloudflareEnv } from "./cloudflare-shared.ts"
import { enterQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from "./state.ts"

const queueNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {
  const runtimeConfig = useRuntimeConfig() as {
    queue?: false | ResolvedQueueOptions
  }

  const applyRuntimeState = () => {
    setQueueRuntimeConfig(runtimeConfig.queue)
    setQueueRuntimeRegistry(queueRegistry)
  }

  applyRuntimeState()

  nitroApp.hooks.hook("request", (event: any) => {
    applyRuntimeState()
    enterQueueRuntimeEvent(event)
  })

  nitroApp.hooks.hook("cloudflare:queue", async ({ batch, env, context }: { batch: CloudflareQueueMessageBatch, context: { waitUntil?: (promise: Promise<unknown>) => void }, env: Record<string, unknown> }) => {
    applyRuntimeState()
    if (runtimeConfig.queue === false || runtimeConfig.queue?.provider !== "cloudflare") {
      return
    }

    setActiveCloudflareEnv(env as Record<string, unknown>)
    const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue))
    if (!definition) {
      return
    }

    const runtimeEvent = createCloudflareRuntimeEvent(env as Record<string, unknown>, context)
    await createCloudflareQueueBatchHandler({
      concurrency: definition.options?.concurrency,
      onError: definition.options?.onError,
      onMessage: async (message, currentBatch) => {
        await runWithQueueRuntimeEvent(runtimeEvent, async () => {
          await definition.handler(createQueueJob(message, currentBatch))
        })
      },
    })(batch as CloudflareQueueMessageBatch)
  })
})

export default queueNitroPlugin
