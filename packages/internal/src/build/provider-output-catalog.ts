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

export class ProviderOutputCatalog {
  #appliedCloudflareContributions = new Map<CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue>()
  #cloudflareContributions = new Map<CloudflareProviderOutputContribution["owner"], CloudflareProviderOutputValue>()
  #runtimeContributions = new Map<ProviderOutputProduct, ProviderRuntimeContribution>()
  #deploymentContributions = new Map<ProviderDeploymentOutputContribution["owner"], {
    contribution: ProviderDeploymentOutputContribution
    generation?: ProviderDeploymentOutputGeneration
  }>()
  #deploymentGenerations = new Set<ProviderDeploymentOutputGeneration>()

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
    this.#deploymentContributions.set(contribution.owner, { contribution, generation })
  }

  resetDeploymentContributions(generation?: ProviderDeploymentOutputGeneration): void {
    if (!generation) {
      for (const current of this.#deploymentGenerations) current.valid = false
      this.#deploymentGenerations.clear()
      this.#deploymentContributions.clear()
      return
    }
    generation.valid = false
    this.#deploymentGenerations.delete(generation)
    for (const [owner, entry] of this.#deploymentContributions) {
      if (entry.generation === generation) this.#deploymentContributions.delete(owner)
    }
  }

  hasDeploymentContributions(): boolean {
    return this.#deploymentContributions.size > 0
  }

  takeDeploymentContributions(): ProviderDeploymentOutputContribution[] {
    const contributions = [...this.#deploymentContributions.values()].map(({ contribution }) => contribution)
    this.#deploymentContributions.clear()
    return contributions
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
