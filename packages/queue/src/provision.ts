import { createCloudflareProvisionClient, resolveCloudflareProvisionConfig } from "@vite-hub/internal/provision"

import { discoverQueueDefinitions } from "./discovery.ts"
import { getCloudflareQueueName } from "./internal/cloudflare-resource-name.ts"

import type { ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"

interface CloudflareQueue {
  queue_name?: string
}

function parseQueues(value: unknown): CloudflareQueue[] {
  if (!Array.isArray(value)) throw new Error("Cloudflare provisioning returned an invalid queue list.")
  // SAFETY: Queue fields are optional and consumers narrow queue_name before use.
  return value as CloudflareQueue[]
}

export function createQueueProvisionStep(resolveRootDir: () => string, resolveNamePrefix: () => string | undefined = () => undefined): ProvisionStep {
  return {
    id: "queue:cloudflare-queues",
    provider: "cloudflare",
    async plan(context) {
      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("queue: skipping Cloudflare queues, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        return []
      }

      const request = createCloudflareProvisionClient(config, context.fetch)
      const namePrefix = resolveNamePrefix()
      const names = discoverQueueDefinitions({ rootDir: resolveRootDir() }).map(definition => getCloudflareQueueName(definition.name, namePrefix))
      if (!names.length) return []

      const listed = await request("/queues", { parse: parseQueues })
      const existing = new Set((listed.result ?? []).map(queue => queue.queue_name).filter((name): name is string => Boolean(name)))

      return names.map((name): ProvisionAction => ({
        kind: "cloudflare-queue",
        name,
        exists: existing.has(name),
        apply: async () => {
          if (!existing.has(name)) {
            await request("/queues", { method: "POST", body: { queue_name: name } })
          }
          return {}
        },
      }))
    },
  }
}
