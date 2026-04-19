import { decodeQueueNameHex, encodeQueueNameHex } from "./encoding.ts"
import type { DiscoveredQueueDefinition, InternalResolvedQueueModuleProviderOptions } from "../types.ts"

export const defaultCloudflareQueueBindingPrefix = "QUEUE"
const cloudflareQueueNamePattern = /^[A-Za-z0-9-]+$/
const encodedCloudflareQueueNamePattern = /^queue--([0-9a-f]{2})+$/i

function pushUnique<T>(array: T[], item: T, getKey: (item: T) => string): void {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key)) array.push(item)
}

export function getCloudflareQueueBindingName(name: string): string {
  const encoded = encodeQueueNameHex(name).toUpperCase()
  return encoded ? `${defaultCloudflareQueueBindingPrefix}_${encoded}` : defaultCloudflareQueueBindingPrefix
}

export function getCloudflareQueueName(name: string): string {
  if (encodedCloudflareQueueNamePattern.test(name)) {
    throw new TypeError("Cloudflare queue names matching `queue--<hex>` are reserved by @vitehub/queue.")
  }
  if (cloudflareQueueNamePattern.test(name)) return name
  const encoded = encodeQueueNameHex(name)
  return encoded ? `queue--${encoded}` : "queue"
}

export function getCloudflareQueueDefinitionName(name: string): string {
  if (!encodedCloudflareQueueNamePattern.test(name)) return name
  return decodeQueueNameHex(name.slice("queue--".length)) || name
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
  provider?: InternalResolvedQueueModuleProviderOptions,
): void {
  if (!provider || provider.provider !== "cloudflare") return
  if (typeof provider.binding === "string" && definitions.length > 1) {
    throw new TypeError(
      "`queue.provider.binding` can only be used with one Cloudflare queue definition. Remove it to use generated per-queue bindings.",
    )
  }

  target.cloudflare ||= {}
  target.cloudflare.wrangler ||= {}
  target.cloudflare.wrangler.queues ||= {}
  target.cloudflare.wrangler.queues.consumers ||= []
  target.cloudflare.wrangler.queues.producers ||= []

  for (const definition of definitions) {
    const queue = getCloudflareQueueName(definition.name)
    const binding = typeof provider.binding === "string"
      ? provider.binding
      : getCloudflareQueueBindingName(definition.name)

    pushUnique(
      target.cloudflare.wrangler.queues.consumers,
      { queue },
      entry => String(entry.queue),
    )
    pushUnique(
      target.cloudflare.wrangler.queues.producers,
      { binding, queue },
      entry => `${String(entry.binding)}:${String(entry.queue)}`,
    )
  }
}
