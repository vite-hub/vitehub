import { isDeepStrictEqual } from "node:util"

import { mergeProviderOutputConfig } from "./provider-output-config.ts"

interface CloudflareQueueConsumer {
  queue: string
  [key: string]: unknown
}

interface CloudflareQueueProducer {
  binding: string
  queue: string
  [key: string]: unknown
}

interface CloudflareR2Bucket {
  binding: string
  bucket_name: string
  [key: string]: unknown
}

interface CloudflareRateLimit {
  name: string
  [key: string]: unknown
}

interface CloudflareProviderOutputContribution {
  queues?: {
    consumers?: CloudflareQueueConsumer[]
    producers?: CloudflareQueueProducer[]
  }
  r2Buckets?: CloudflareR2Bucket[]
  rateLimits?: CloudflareRateLimit[]
}

interface CloudflareProviderOutputCatalog {
  appliedByOwner: Map<string, CloudflareProviderOutputContribution>
  contributionsByOwner: Map<string, CloudflareProviderOutputContribution>
}

const cloudflareProviderOutputKey = Symbol.for("vitehub.cloudflareProviderOutput")

function cloneRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function cloneProviderRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => typeof entry === "undefined" ? [] : [[key, cloneProviderValue(entry)]]))
}

function cloneProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => typeof entry === "undefined" ? null : cloneProviderValue(entry))
  if (value && typeof value === "object") return cloneProviderRecord(value)
  return value
}

function useCloudflareProviderOutput(config: object): CloudflareProviderOutputCatalog {
  const owner = config as Record<symbol, CloudflareProviderOutputCatalog | undefined>
  return (owner[cloudflareProviderOutputKey] ??= { appliedByOwner: new Map(), contributionsByOwner: new Map() })
}

export function registerCloudflareProviderOutput(config: object, owner: string, contribution: CloudflareProviderOutputContribution): void {
  useCloudflareProviderOutput(config).contributionsByOwner.set(owner, contribution)
}

function compatibleEntries<T extends Record<string, unknown>>(existing: unknown, incoming: T[] | undefined, identityKey: keyof T & string, conflictKeys: Array<keyof T & string>, owner: string): T[] {
  const current = Array.isArray(existing) ? existing.map(cloneProviderRecord) : []
  return (incoming ?? []).filter((entry) => {
    const identity = entry[identityKey]
    const match = current.find((candidate) => candidate[identityKey] === identity)
    if (!match) {
      current.push(entry)
      return true
    }
    if (conflictKeys.some((key) => !isDeepStrictEqual(match[key], entry[key]))) {
      throw new Error(`[vitehub] Cloudflare ${identityKey} ${JSON.stringify(identity)} from ${owner} is already assigned to an incompatible resource.`)
    }
    return false
  })
}

function removeEntries(existing: unknown, entries: Array<Record<string, unknown>> | undefined): unknown[] {
  if (!Array.isArray(existing) || !entries?.length) return Array.isArray(existing) ? existing : []
  return existing.filter(entry => !entries.some(previous => isDeepStrictEqual(entry, previous)))
}

function removeContribution(wrangler: Record<string, unknown>, contribution: CloudflareProviderOutputContribution): Record<string, unknown> {
  const queues = cloneProviderRecord(wrangler.queues)
  const hasQueues = Boolean(contribution.queues?.consumers?.length || contribution.queues?.producers?.length)
  return {
    ...wrangler,
    ...(hasQueues ? {
      queues: {
        ...queues,
        consumers: removeEntries(queues.consumers, contribution.queues?.consumers),
        producers: removeEntries(queues.producers, contribution.queues?.producers),
      },
    } : {}),
    ...(contribution.r2Buckets?.length ? { r2_buckets: removeEntries(wrangler.r2_buckets, contribution.r2Buckets) } : {}),
    ...(contribution.rateLimits?.length ? { ratelimits: removeEntries(wrangler.ratelimits, contribution.rateLimits) } : {}),
  }
}

function mergeContribution(wrangler: Record<string, unknown>, owner: string, contribution: CloudflareProviderOutputContribution): [Record<string, unknown>, CloudflareProviderOutputContribution] {
  const queues = cloneProviderRecord(wrangler.queues)
  const consumers = compatibleEntries(queues.consumers, contribution.queues?.consumers, "queue", [], owner)
  const producers = compatibleEntries(queues.producers, contribution.queues?.producers, "binding", ["queue"], owner)
  const r2Buckets = compatibleEntries(wrangler.r2_buckets, contribution.r2Buckets, "binding", ["bucket_name"], owner)
  const rateLimits = compatibleEntries(wrangler.ratelimits, contribution.rateLimits, "name", ["namespace_id", "simple"], owner)
  const nextQueues = mergeProviderOutputConfig(
    queues,
    {
      ...(consumers.length ? { consumers } : {}),
      ...(producers.length ? { producers } : {}),
    },
    {
      arrays: {
        consumers: { key: "queue" },
        producers: { key: "binding" },
      },
    },
  )
  return [mergeProviderOutputConfig(
    wrangler,
    {
      ...(Object.keys(nextQueues).length ? { queues: nextQueues } : {}),
      ...(r2Buckets.length ? { r2_buckets: r2Buckets } : {}),
      ...(rateLimits.length ? { ratelimits: rateLimits } : {}),
    },
    {
      arrays: {
        r2_buckets: { key: "binding" },
        ratelimits: { key: "name" },
      },
    },
  ), {
    queues: { consumers, producers },
    r2Buckets,
    rateLimits,
  }]
}

export function composeNitroCloudflareProviderOutput(config: object, value: unknown): Record<string, unknown> {
  const nitro = cloneRecord(value)
  const cloudflare = cloneRecord(nitro.cloudflare)
  const catalog = useCloudflareProviderOutput(config)
  let wrangler = cloneProviderRecord(cloudflare.wrangler)
  for (const contribution of catalog.appliedByOwner.values()) wrangler = removeContribution(wrangler, contribution)
  catalog.appliedByOwner.clear()
  for (const [owner, contribution] of catalog.contributionsByOwner) {
    const [merged, applied] = mergeContribution(wrangler, owner, contribution)
    wrangler = merged
    catalog.appliedByOwner.set(owner, applied)
  }
  return { ...nitro, cloudflare: { ...cloudflare, wrangler } }
}
