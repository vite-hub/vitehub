import type { VercelFunctionRuntimePackage } from "./vercel-runtime-packages.ts"
import type { ProviderDeploymentOutputContribution } from "./deployment-output.ts"

export interface CloudflareQueueConsumer {
  queue: string
  [key: string]: unknown
}

export interface CloudflareQueueProducer {
  binding: string
  queue: string
  [key: string]: unknown
}

export interface CloudflareR2Bucket {
  binding: string
  bucket_name: string
  [key: string]: unknown
}

export interface CloudflareRateLimit {
  name: string
  [key: string]: unknown
}

export type CloudflareProviderOutputContribution =
  | { owner: "blob", r2Buckets?: CloudflareR2Bucket[] }
  | { owner: "env", requiredSecrets?: string[] }
  | { owner: "queue", queues?: { consumers?: CloudflareQueueConsumer[], producers?: CloudflareQueueProducer[] } }
  | { owner: "rate-limit", rateLimits?: CloudflareRateLimit[] }

export interface CloudflareProviderOutputValue {
  queues?: {
    consumers?: CloudflareQueueConsumer[]
    producers?: CloudflareQueueProducer[]
  }
  r2Buckets?: CloudflareR2Bucket[]
  rateLimits?: CloudflareRateLimit[]
  requiredSecrets?: string[]
  requiredSecretsByEnvironment?: Record<string, string[]>
}

interface ProviderRuntimeModulesByProduct {
  blob: {
    cloudflare?: string
    vercel?: string
  }
  database: {
    cloudflare?: string
    "cloudflare-definition-defaults"?: string
    vercel?: string
    "vercel-definition-defaults"?: string
  }
  "rate-limit": {
    cloudflare?: string
  }
}

export type ProviderOutputProduct = keyof ProviderRuntimeModulesByProduct
export type ProviderRuntimeKind = {
  [Product in ProviderOutputProduct]: keyof ProviderRuntimeModulesByProduct[Product]
}[ProviderOutputProduct]

export type ProviderRuntimeContribution = {
  [Product in ProviderOutputProduct]: {
    owner: Product
    runtimeModules: ProviderRuntimeModulesByProduct[Product]
  } & (Product extends "blob" ? { vercelRuntimePackages?: VercelFunctionRuntimePackage[] } : Record<never, never>)
}[ProviderOutputProduct]

export interface ProviderDeploymentOutputGeneration {
  valid: boolean
}

interface ProviderDeploymentOutputEntry {
  contribution: ProviderDeploymentOutputContribution
  generation?: ProviderDeploymentOutputGeneration
  sequence: number
}

export class ProviderOutputCatalog {
  #appliedCloudflareContributions = new Map<CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue>()
  #cloudflareContributions = new Map<CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue>()
  #runtimeContributions = new Map<ProviderOutputProduct, ProviderRuntimeContribution>()
  #deploymentContributionSequence = 0
  #deploymentContributions = new Map<ProviderDeploymentOutputContribution["owner"], ProviderDeploymentOutputEntry[]>()
  #deploymentGenerations = new Set<ProviderDeploymentOutputGeneration>()
  #takenDeploymentContributions = new Map<ProviderDeploymentOutputContribution, {
    entry: ProviderDeploymentOutputEntry
    fallbacks: ProviderDeploymentOutputEntry[]
  }>()

  appliedCloudflareContributions(): IterableIterator<CloudflareProviderOutputValue> {
    return this.#appliedCloudflareContributions.values()
  }

  appliedCloudflareContributionEntries(): IterableIterator<[CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue]> {
    return this.#appliedCloudflareContributions.entries()
  }

  clearAppliedCloudflareContributions(): void {
    this.#appliedCloudflareContributions.clear()
  }

  cloudflareContributions(): IterableIterator<[CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue]> {
    return this.#cloudflareContributions.entries()
  }

  inheritCloudflareContributions(catalog: ProviderOutputCatalog): void {
    for (const [owner, contribution] of catalog.appliedCloudflareContributionEntries()) this.#appliedCloudflareContributions.set(owner, contribution)
    for (const [owner, contribution] of [...catalog.cloudflareContributions(), ...this.#cloudflareContributions]) {
      this.#cloudflareContributions.set(owner, contribution)
    }
  }

  replaceAppliedCloudflareContribution(owner: CloudflareProviderOutputContribution["owner"], contribution: CloudflareProviderOutputValue): void {
    this.#appliedCloudflareContributions.set(owner, contribution)
  }

  replaceCloudflareContribution(owner: CloudflareProviderOutputContribution["owner"], contribution: CloudflareProviderOutputValue): void {
    this.#cloudflareContributions.set(owner, contribution)
  }

  replaceRuntimeContribution(contribution: ProviderRuntimeContribution): void {
    this.#runtimeContributions.set(contribution.owner, contribution)
  }

  runtimeContribution(product: ProviderOutputProduct): ProviderRuntimeContribution | undefined {
    return this.#runtimeContributions.get(product)
  }

  runtimeContributions(): IterableIterator<[ProviderOutputProduct, ProviderRuntimeContribution]> {
    return this.#runtimeContributions.entries()
  }

  resetRuntimeContributions(): void {
    this.#runtimeContributions.clear()
  }

  createDeploymentGeneration(): ProviderDeploymentOutputGeneration {
    const generation = { valid: true }
    this.#deploymentGenerations.add(generation)
    return generation
  }

  replaceDeploymentContribution(contribution: ProviderDeploymentOutputContribution, generation?: ProviderDeploymentOutputGeneration): void {
    if (generation && !generation.valid) return
    this.#restoreDeploymentContribution({
      contribution,
      generation,
      sequence: this.#deploymentContributionSequence++,
    })
  }

  resetDeploymentContributions(generation?: ProviderDeploymentOutputGeneration): void {
    if (!generation) {
      for (const current of this.#deploymentGenerations) current.valid = false
      this.#deploymentGenerations.clear()
      this.#deploymentContributions.clear()
      this.#takenDeploymentContributions.clear()
      return
    }
    generation.valid = false
    this.#deploymentGenerations.delete(generation)
    for (const [owner, entries] of this.#deploymentContributions) {
      const remaining = entries.filter(entry => entry.generation !== generation)
      if (remaining.length) this.#deploymentContributions.set(owner, remaining)
      else this.#deploymentContributions.delete(owner)
    }
    for (const [contribution, taken] of this.#takenDeploymentContributions) {
      taken.fallbacks = taken.fallbacks.filter(entry => entry.generation !== generation)
      if (taken.entry.generation !== generation) continue
      this.#takenDeploymentContributions.delete(contribution)
      for (const fallback of taken.fallbacks) this.#restoreDeploymentContribution(fallback)
    }
  }

  hasDeploymentContributions(): boolean {
    return this.#deploymentContributions.size > 0
  }

  takeDeploymentContributions(): ProviderDeploymentOutputContribution[] {
    const contributions: ProviderDeploymentOutputContribution[] = []
    for (const [owner, entries] of this.#deploymentContributions) {
      const entry = entries.at(-1)!
      contributions.push(entry.contribution)
      this.#takenDeploymentContributions.set(entry.contribution, {
        entry,
        fallbacks: entries.slice(0, -1),
      })
      this.#deploymentContributions.delete(owner)
    }
    return contributions
  }

  deploymentContributionGeneration(contribution: ProviderDeploymentOutputContribution): ProviderDeploymentOutputGeneration | undefined {
    return this.#takenDeploymentContributions.get(contribution)?.entry.generation
  }

  async completeDeploymentContributions(contributions: ProviderDeploymentOutputContribution[]): Promise<void> {
    const discarded: Array<Promise<void>> = []
    for (const contribution of contributions) {
      const taken = this.#takenDeploymentContributions.get(contribution)
      if (!taken) continue
      this.#takenDeploymentContributions.delete(contribution)
      for (const entry of [...taken.fallbacks, taken.entry]) {
        if (entry.contribution.discard) discarded.push(entry.contribution.discard())
      }
    }
    const results = await Promise.allSettled(discarded)
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
  }

  rollbackDeploymentContributions(contributions: ProviderDeploymentOutputContribution[]): void {
    for (const contribution of contributions) {
      const taken = this.#takenDeploymentContributions.get(contribution)
      if (!taken) continue
      this.#takenDeploymentContributions.delete(contribution)
      for (const entry of [...taken.fallbacks, taken.entry]) this.#restoreDeploymentContribution(entry)
    }
  }

  #restoreDeploymentContribution(entry: ProviderDeploymentOutputEntry): void {
    if (entry.generation && !entry.generation.valid) return
    const entries = this.#deploymentContributions.get(entry.contribution.owner) ?? []
    const replaced = entries.findIndex(candidate => candidate.generation === entry.generation)
    if (replaced >= 0) {
      if (entries[replaced]!.sequence > entry.sequence) return
      entries.splice(replaced, 1)
    }
    entries.push(entry)
    entries.sort((left, right) => left.sequence - right.sequence)
    this.#deploymentContributions.set(entry.contribution.owner, entries)
  }
}

const providerOutputCatalogRegistry = globalThis as typeof globalThis & {
  __vitehubProviderOutputCatalogs?: WeakMap<object, ProviderOutputCatalog>
}
const providerOutputCatalogs = providerOutputCatalogRegistry.__vitehubProviderOutputCatalogs
  ??= new WeakMap<object, ProviderOutputCatalog>()
const providerOutputCatalog = Symbol.for("vitehub.provider-output-catalog")

interface ProviderOutputCatalogOwner {
  [providerOutputCatalog]?: ProviderOutputCatalog
}

export function createProviderOutputCatalog(): ProviderOutputCatalog {
  return new ProviderOutputCatalog()
}

export function useProviderOutputCatalog(config: object): ProviderOutputCatalog {
  // SAFETY: The symbol property is optional and stores only ProviderOutputCatalog values on config objects owned by this module.
  const owner = config as ProviderOutputCatalogOwner
  let catalog = owner[providerOutputCatalog] ?? providerOutputCatalogs.get(config)
  if (!catalog) {
    catalog = createProviderOutputCatalog()
  }
  owner[providerOutputCatalog] = catalog
  providerOutputCatalogs.set(config, catalog)
  return catalog
}

export function contributeCloudflareProviderOutput(catalog: ProviderOutputCatalog, contribution: CloudflareProviderOutputContribution): void {
  const { owner, ...value } = contribution
  catalog.replaceCloudflareContribution(owner, value)
}

export function contributeProviderRuntime(catalog: ProviderOutputCatalog | undefined, contribution: ProviderRuntimeContribution): void {
  catalog?.replaceRuntimeContribution(contribution)
}

export function resetProviderOutputRuntime(catalog: ProviderOutputCatalog | undefined): void {
  catalog?.resetRuntimeContributions()
}

export function getProviderRuntimeModule<
  Product extends ProviderOutputProduct,
  Provider extends keyof ProviderRuntimeModulesByProduct[Product],
>(catalog: ProviderOutputCatalog | undefined, product: Product, provider: Provider): string | undefined {
  const contribution = catalog?.runtimeContribution(product)
  if (!contribution) return
  const runtimeModules = contribution.runtimeModules as ProviderRuntimeModulesByProduct[Product]
  return runtimeModules[provider] as string | undefined
}

export function hasProviderRuntimeModule(
  catalog: ProviderOutputCatalog | undefined,
  provider: ProviderRuntimeKind,
  options: { except?: ProviderOutputProduct } = {},
): boolean {
  if (!catalog) return false
  return [...catalog.runtimeContributions()]
    .some(([product, contribution]) => product !== options.except && provider in contribution.runtimeModules)
}

export function getVercelRuntimePackages(catalog: ProviderOutputCatalog | undefined, product: "blob"): VercelFunctionRuntimePackage[] {
  const contribution = catalog?.runtimeContribution(product)
  return contribution?.owner === "blob" ? contribution.vercelRuntimePackages ?? [] : []
}
