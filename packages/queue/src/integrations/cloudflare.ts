import { getCloudflareQueueBindingName } from "../providers/cloudflare.ts"
import type { DiscoveredQueueDefinition, InternalQueueProviderOptions } from "../types.ts"

function pushUnique<T>(array: T[], item: T, getKey: (item: T) => string): void {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key)) array.push(item)
}

export function configureCloudflareQueues(
  target: {
    cloudflare?: {
      wrangler?: {
        queues?: {
          consumers?: Array<Record<string, unknown>>
          producers?: Array<Record<string, unknown>>
        }
      }
    }
  },
  definitions: DiscoveredQueueDefinition[],
  provider?: InternalQueueProviderOptions,
): void {
  if (!provider || provider.provider !== "cloudflare") return

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.queues ||= {}
  target.cloudflare.wrangler.queues.consumers ||= []
  target.cloudflare.wrangler.queues.producers ||= []

  for (const definition of definitions) {
    const binding = typeof provider.binding === "string"
      ? provider.binding
      : getCloudflareQueueBindingName(definition.name)

    pushUnique(
      target.cloudflare.wrangler.queues.consumers,
      { queue: definition.name },
      entry => String(entry.queue),
    )
    pushUnique(
      target.cloudflare.wrangler.queues.producers,
      { binding, queue: definition.name },
      entry => String(entry.binding),
    )
  }
}
