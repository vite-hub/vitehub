import { defu } from "defu"

import { readEnv, trimmed } from "@vitehub/internal/env"
import { normalizeHosting } from "@vitehub/internal/feature-bridge/hosting"
import { isPlainObject } from "@vitehub/internal/object"

import type {
  BlobModuleOptions,
  BlobStoreConfig,
  BlobStoresConfig,
  CloudflareR2BlobStoreConfig,
  FsBlobStoreConfig,
  ResolvedBlobModuleOptions,
  ResolvedCloudflareR2BlobStoreConfig,
  ResolvedFsBlobStoreConfig,
  ResolvedVercelBlobStoreConfig,
  VercelBlobStoreConfig,
} from "./types.ts"

export interface BlobResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

export const MASKED_BLOB_RUNTIME_VALUE = "********"

function resolveFsStore(
  config: Partial<FsBlobStoreConfig> = {},
): ResolvedFsBlobStoreConfig {
  return defu({ base: trimmed(config.base) }, { base: ".data/blob", driver: "fs" as const })
}

function resolveCloudflareStore(
  config: Partial<CloudflareR2BlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareR2BlobStoreConfig {
  return defu(
    {
      binding: trimmed(config.binding),
      bucketName: trimmed(config.bucketName) ?? readEnv(env, "BLOB_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME"),
    },
    { binding: "BLOB", driver: "cloudflare-r2" as const },
  )
}

function resolveVercelStore(
  config: Partial<VercelBlobStoreConfig> = {},
): ResolvedVercelBlobStoreConfig {
  return {
    access: config.access ?? "public",
    driver: "vercel-blob",
    token: trimmed(config.token) ?? MASKED_BLOB_RUNTIME_VALUE,
  }
}

function resolveExplicitStore(
  store: BlobStoreConfig,
  env: Record<string, string | undefined>,
) {
  switch (store.driver) {
    case "cloudflare-r2":
      return resolveCloudflareStore(store, env)
    case "fs":
      return resolveFsStore(store)
    case "vercel-blob":
      return resolveVercelStore(store)
    case "akamai":
    case "azure":
    case "box":
    case "digitalocean-spaces":
    case "dropbox":
    case "gcs":
    case "google-drive":
    case "hetzner":
    case "minio":
    case "netlify-blobs":
    case "onedrive":
    case "s3":
    case "storj":
    case "supabase":
    case "uploadthing":
      return store
    default:
      throw new TypeError(`Unknown \`blob.driver\`: ${JSON.stringify((store as { driver: unknown }).driver)}.`)
  }
}

function createResolvedConfig(store: ResolvedBlobModuleOptions["store"], stores?: Record<string, ResolvedBlobModuleOptions["store"]>): ResolvedBlobModuleOptions {
  return stores ? { store, stores: { default: store, ...stores } } : { store }
}

function hasStoresConfig(options: BlobModuleOptions | undefined): options is BlobStoresConfig {
  return !!options && "stores" in options && isPlainObject((options as { stores?: unknown }).stores)
}

export function hasVercelBlobEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(readEnv(env, "BLOB_READ_WRITE_TOKEN"))
}

export function normalizeBlobOptions(
  options: BlobModuleOptions | undefined,
  input: BlobResolutionInput = {},
): ResolvedBlobModuleOptions | undefined {
  if (options === false) {
    return
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`blob` must be a plain object.")
  }

  const env = input.env || process.env
  const hosting = normalizeHosting(input.hosting)
  const explicit = options as BlobStoreConfig | undefined
  const implicitCloudflare = options as Partial<CloudflareR2BlobStoreConfig> | undefined

  if (hasStoresConfig(options)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(options.stores).map(([name, store]) => [name, resolveExplicitStore(store, env)]),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw new TypeError("`blob.stores.default` is required when using named Blob stores.")
    return createResolvedConfig(defaultStore, resolvedStores)
  }

  if (explicit?.driver) {
    return createResolvedConfig(resolveExplicitStore(explicit, env))
  }

  if (hosting.includes("cloudflare")) {
    return createResolvedConfig(resolveCloudflareStore(implicitCloudflare, env))
  }

  if (hasVercelBlobEnv(env)) {
    return createResolvedConfig(resolveVercelStore())
  }

  if (hosting.includes("vercel")) {
    return createResolvedConfig(resolveVercelStore())
  }

  return createResolvedConfig(resolveFsStore())
}

export function warnVercelBlobFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedBlobModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !normalizeHosting(hosting).includes("vercel")) return
  const stores = Object.values(config.stores || { default: config.store })
  if (!stores.some(store => store.driver === "fs")) return
  target.logger?.error?.("Vercel hosting requires Vercel Blob-backed storage. Set `BLOB_READ_WRITE_TOKEN`.")
}

export function isMaskedBlobRuntimeValue(value: string | undefined): boolean {
  return !value || value === MASKED_BLOB_RUNTIME_VALUE
}

export function resolveRuntimeVercelBlobStore(
  config: ResolvedVercelBlobStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedVercelBlobStoreConfig {
  const token = isMaskedBlobRuntimeValue(config.token)
    ? readEnv(env, "BLOB_READ_WRITE_TOKEN") || config.token
    : config.token

  if (isMaskedBlobRuntimeValue(token)) {
    throw new Error("Missing runtime environment variable `BLOB_READ_WRITE_TOKEN` for Vercel Blob.")
  }

  return {
    ...config,
    token,
  }
}
