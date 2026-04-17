import type { DiscoveredQueueDefinition, QueueProviderOptions } from "../types.ts"

export const defaultCloudflareQueueBindingPrefix = "QUEUE"
const cloudflareQueueNamePattern = /^[A-Za-z0-9-]+$/
const encodedCloudflareQueueNamePattern = /^queue-([0-9a-f]{2})+$/i

function pushUnique<T>(array: T[], item: T, getKey: (item: T) => string): void {
  const key = getKey(item)
  if (!array.some(entry => getKey(entry) === key)) array.push(item)
}

function encodeQueueName(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

function decodeQueueName(name: string): string | undefined {
  if (!encodedCloudflareQueueNamePattern.test(name)) return

  const encoded = name.slice("queue-".length)
  const bytes = encoded.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []
  if (!bytes.length || bytes.some(byte => !Number.isFinite(byte))) return
  return new TextDecoder().decode(new Uint8Array(bytes))
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

export function getCloudflareQueueName(name: string): string {
  if (cloudflareQueueNamePattern.test(name)) return name
  const encoded = encodeQueueName(name)
  return encoded ? `queue-${encoded}` : "queue"
}

export function getCloudflareQueueDefinitionName(name: string): string {
  return decodeQueueName(name) || name
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
      entry => String(entry.queue),
    )
  }
}
