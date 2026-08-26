import { isDeepStrictEqual } from "node:util"

import { mergeProviderOutputConfig } from "./provider-output-config.ts"
import type { CloudflareProviderOutputValue, ProviderOutputCatalog } from "./provider-output-catalog.ts"

const providerOutputCatalogRegistry = globalThis as typeof globalThis & {
  __vitehubProviderOutputCatalogsByNitroValue?: WeakMap<object, ProviderOutputCatalog>
}
const providerOutputCatalogByNitroValue = providerOutputCatalogRegistry.__vitehubProviderOutputCatalogsByNitroValue
  ??= new WeakMap<object, ProviderOutputCatalog>()

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

function removeEntries(existing: unknown, entries: unknown[] | undefined): unknown[] {
  if (!Array.isArray(existing) || !entries?.length) return Array.isArray(existing) ? existing : []
  return existing.filter(entry => !entries.some(previous => isDeepStrictEqual(entry, previous)))
}

function removeContribution(wrangler: Record<string, unknown>, contribution: CloudflareProviderOutputValue): Record<string, unknown> {
  const queues = cloneProviderRecord(wrangler.queues)
  const secrets = cloneProviderRecord(wrangler.secrets)
  const environments = cloneProviderRecord(wrangler.env)
  const hasQueues = Boolean(contribution.queues?.consumers?.length || contribution.queues?.producers?.length)
  const hasSecrets = Boolean(contribution.requiredSecrets?.length || Object.keys(contribution.requiredSecretsByEnvironment ?? {}).length)
  if (contribution.queues?.consumers?.length) {
    const consumers = removeEntries(queues.consumers, contribution.queues.consumers)
    if (consumers.length) queues.consumers = consumers
    else delete queues.consumers
  }
  if (contribution.queues?.producers?.length) {
    const producers = removeEntries(queues.producers, contribution.queues.producers)
    if (producers.length) queues.producers = producers
    else delete queues.producers
  }
  if (contribution.requiredSecrets?.length) {
    const required = removeEntries(secrets.required, contribution.requiredSecrets)
    if (required.length) secrets.required = required
    else delete secrets.required
  }
  for (const [name, requiredSecrets] of Object.entries(contribution.requiredSecretsByEnvironment ?? {})) {
    if (!(name in environments)) continue
    const environment = cloneProviderRecord(environments[name])
    const environmentSecrets = cloneProviderRecord(environment.secrets)
    const required = removeEntries(environmentSecrets.required, requiredSecrets)
    if (required.length) environmentSecrets.required = required
    else delete environmentSecrets.required
    if (Object.keys(environmentSecrets).length) environment.secrets = environmentSecrets
    else delete environment.secrets
    environments[name] = environment
  }
  const withoutOwned = { ...wrangler }
  if (hasQueues) delete withoutOwned.queues
  if (hasSecrets) delete withoutOwned.secrets
  if (hasSecrets) delete withoutOwned.env
  return {
    ...withoutOwned,
    ...(hasQueues && Object.keys(queues).length ? { queues } : {}),
    ...(hasSecrets && Object.keys(secrets).length ? { secrets } : {}),
    ...(hasSecrets && Object.keys(environments).length ? { env: environments } : {}),
    ...(contribution.r2Buckets?.length ? { r2_buckets: removeEntries(wrangler.r2_buckets, contribution.r2Buckets) } : {}),
    ...(contribution.rateLimits?.length ? { ratelimits: removeEntries(wrangler.ratelimits, contribution.rateLimits) } : {}),
  }
}

function mergeContribution(wrangler: Record<string, unknown>, owner: string, contribution: CloudflareProviderOutputValue): [Record<string, unknown>, CloudflareProviderOutputValue] {
  const queues = cloneProviderRecord(wrangler.queues)
  const secrets = cloneProviderRecord(wrangler.secrets)
  const environments = cloneProviderRecord(wrangler.env)
  const consumers = compatibleEntries(queues.consumers, contribution.queues?.consumers, "queue", [], owner)
  const producers = compatibleEntries(queues.producers, contribution.queues?.producers, "binding", ["queue"], owner)
  const r2Buckets = compatibleEntries(wrangler.r2_buckets, contribution.r2Buckets, "binding", ["bucket_name"], owner)
  const rateLimits = compatibleEntries(wrangler.ratelimits, contribution.rateLimits, "name", ["namespace_id", "simple"], owner)
  const currentRequiredSecrets = Array.isArray(secrets.required) ? secrets.required : []
  const requiredSecrets = (contribution.requiredSecrets ?? []).filter(name => !currentRequiredSecrets.includes(name))
  if (requiredSecrets.length) secrets.required = [...currentRequiredSecrets, ...requiredSecrets]
  const requiredSecretsByEnvironment: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(environments)) {
    const environment = cloneProviderRecord(value)
    const environmentSecrets = cloneProviderRecord(environment.secrets)
    const current = Array.isArray(environmentSecrets.required) ? environmentSecrets.required : []
    const required = (contribution.requiredSecrets ?? []).filter(secret => !current.includes(secret))
    if (required.length) {
      environmentSecrets.required = [...current, ...required]
      environment.secrets = environmentSecrets
      environments[name] = environment
      requiredSecretsByEnvironment[name] = required
    }
  }
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
      ...(Object.keys(secrets).length ? { secrets } : {}),
      ...(Object.keys(environments).length ? { env: environments } : {}),
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
    requiredSecrets,
    requiredSecretsByEnvironment,
  }]
}

function inheritedProviderOutputCatalog(value: unknown): ProviderOutputCatalog | undefined {
  if (!value || typeof value !== "object") return
  const nitro = value as Record<string, unknown>
  const cloudflare = nitro.cloudflare
  const wrangler = cloudflare && typeof cloudflare === "object" ? (cloudflare as Record<string, unknown>).wrangler : undefined
  return providerOutputCatalogByNitroValue.get(value)
    ?? (cloudflare && typeof cloudflare === "object" ? providerOutputCatalogByNitroValue.get(cloudflare) : undefined)
    ?? (wrangler && typeof wrangler === "object" ? providerOutputCatalogByNitroValue.get(wrangler) : undefined)
}

function associateProviderOutputCatalog(output: Record<string, unknown>, catalog: ProviderOutputCatalog): void {
  providerOutputCatalogByNitroValue.set(output, catalog)
  const cloudflare = output.cloudflare
  if (!cloudflare || typeof cloudflare !== "object") return
  providerOutputCatalogByNitroValue.set(cloudflare, catalog)
  const wrangler = (cloudflare as Record<string, unknown>).wrangler
  if (wrangler && typeof wrangler === "object") providerOutputCatalogByNitroValue.set(wrangler, catalog)
}

export function composeNitroCloudflareProviderOutput(catalog: ProviderOutputCatalog, value: unknown, inheritedValue: unknown = value): Record<string, unknown> {
  const nitro = cloneRecord(value)
  const cloudflare = cloneRecord(nitro.cloudflare)
  const inherited = inheritedProviderOutputCatalog(inheritedValue) ?? inheritedProviderOutputCatalog(value)
  if (inherited && inherited !== catalog) catalog.inheritCloudflareContributions(inherited)
  let wrangler = cloneProviderRecord(cloudflare.wrangler)
  for (const contribution of catalog.appliedCloudflareContributions()) wrangler = removeContribution(wrangler, contribution)
  catalog.clearAppliedCloudflareContributions()
  for (const [owner, contribution] of catalog.cloudflareContributions()) {
    const [merged, applied] = mergeContribution(wrangler, owner, contribution)
    wrangler = merged
    catalog.replaceAppliedCloudflareContribution(owner, applied)
  }
  const output = !Object.keys(cloudflare).length && !Object.keys(wrangler).length
    ? nitro
    : { ...nitro, cloudflare: { ...cloudflare, wrangler } }
  associateProviderOutputCatalog(output, catalog)
  return output
}
