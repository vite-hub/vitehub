import type { DiscoveredQueueDefinition, QueueProviderOptions } from "../types.ts"

export const defaultCloudflareQueueBindingPrefix = "QUEUE"

function pushUnique<T>(array: T[], item: T, getKey: (item: T) => string): void {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key)) array.push(item)
}

export function getCloudflareQueueBindingName(name: string): string {
  const normalized = (name.match(/[a-z0-9]+/gi) || [])
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()

  return normalized ? `${defaultCloudflareQueueBindingPrefix}_${normalized}` : defaultCloudflareQueueBindingPrefix
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
  provider?: QueueProviderOptions,
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
