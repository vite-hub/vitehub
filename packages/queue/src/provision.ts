import { createCloudflareProvisionClient, isShellSafeProvisionValue, resolveCloudflareProvisionConfig } from "@vite-hub/internal/provision"

import { discoverQueueDefinitions } from "./discovery.ts"
import { getCloudflareQueueName } from "./internal/cloudflare-resource-name.ts"

import type { ProvisionAction, ProvisionStep } from "@vite-hub/internal/provision"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

/** Provision State category for Cloudflare Queue names, keyed by Queue Definition name. Config never reads it, because Queue names come from Definitions. */
const QUEUE_CLOUDFLARE_PROVISION_CATEGORY = "queue"

interface CloudflareQueue {
  queue_name?: string
}

function parseQueues(value: unknown): CloudflareQueue[] {
  if (!Array.isArray(value)
    || Array.from(value).some((queue, index) => !(index in value)
      || queue === null
      || typeof queue !== "object"
      || Array.isArray(queue))) {
    throw queueErrorDiagnostics.QUEUE_PROVISION_FAILED()
  }
  // SAFETY: Queue fields are optional and consumers narrow queue_name before use.
  return value as CloudflareQueue[]
}

export function createQueueProvisionStep(resolveRootDir: () => string, resolveNamePrefix: () => string | undefined = () => undefined): ProvisionStep {
  return {
    id: "queue:cloudflare-queues",
    provider: "cloudflare",
    recordedState() {
      return [{
        category: QUEUE_CLOUDFLARE_PROVISION_CATEGORY,
        declared: discoverQueueDefinitions({ rootDir: resolveRootDir() }).map(definition => definition.name),
        deleteHint: ({ id }) => isShellSafeProvisionValue(id)
          ? `run \`wrangler queues delete ${id}\``
          : "delete the Queue in the Cloudflare dashboard",
      }]
    },
    async plan(context) {
      const config = resolveCloudflareProvisionConfig(context.env)
      if (!config) {
        context.logger.warn("queue: skipping Cloudflare queues, missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN.")
        context.markPlanUnchecked?.()
        return []
      }

      const request = createCloudflareProvisionClient(config, context.fetch)
      const namePrefix = resolveNamePrefix()
      const queues = discoverQueueDefinitions({ rootDir: resolveRootDir() }).map(definition => ({ definition: definition.name, name: getCloudflareQueueName(definition.name, namePrefix) }))
      if (!queues.length) return []

      const listed = await request("/queues", { parse: parseQueues })
      const existing = new Set((listed.result ?? []).map(queue => queue.queue_name).filter((name): name is string => Boolean(name)))

      return queues.map(({ definition, name }): ProvisionAction => ({
        kind: "cloudflare-queue",
        name,
        exists: existing.has(name),
        apply: async () => {
          if (!existing.has(name)) {
            await request("/queues", { method: "POST", body: { queue_name: name } })
          }
          return { ids: { cloudflare: { [QUEUE_CLOUDFLARE_PROVISION_CATEGORY]: { [definition]: name } } } }
        },
      }))
    },
  }
}
