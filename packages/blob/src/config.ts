import { defu } from "defu"

import { readEnv, trimmed } from "@vite-hub/internal/env"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type {
  BlobModuleOptions,
  BlobStoreConfig,
  BlobStoresConfig,
  CloudflareR2BlobStoreConfig,
  FsBlobStoreConfig,
  MinioBlobStoreConfig,
  NetlifyBlobsStoreConfig,
  ResolvedBlobModuleOptions,
  ResolvedCloudflareR2BlobStoreConfig,
  ResolvedFsBlobStoreConfig,
  ResolvedMinioBlobStoreConfig,
  ResolvedVercelBlobStoreConfig,
  VercelBlobStoreConfig,
  BlobServeOptions,
} from "./types.ts"

export interface BlobResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

export const MASKED_BLOB_RUNTIME_VALUE = "********"
const DEFAULT_MINIO_BUCKET = "vitehub-blob"
const DEFAULT_MINIO_ENDPOINT = "http://localhost:9000"
const DEFAULT_MINIO_REGION = "us-east-1"
const DEFAULT_NETLIFY_BLOBS_STORE = "vitehub-blob"
export const DEFAULT_BLOB_SERVE_ROUTE = "/api/_vitehub/blob"
const MINIO_ACCESS_KEY_ENV = ["MINIO_ACCESS_KEY_ID", "MINIO_ACCESS_KEY", "MINIO_ROOT_USER", "AWS_ACCESS_KEY_ID"] as const
const MINIO_SECRET_KEY_ENV = ["MINIO_SECRET_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_ROOT_PASSWORD", "AWS_SECRET_ACCESS_KEY"] as const

function resolveFsStore(
  config: Partial<FsBlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedFsBlobStoreConfig {
  return defu({ base: trimmed(config.base) ?? readEnv(env, "BLOB_FS_BASE") }, { base: ".vitehub/data/blob", driver: "fs" as const })
}

function resolveCloudflareStore(
  config: Partial<CloudflareR2BlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareR2BlobStoreConfig {
  return defu(
    {
      ...config,
      accountId: resolveBuildRuntimeValue(config.accountId, env, "R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"),
      accessKeyId: resolveBuildRuntimeValue(config.accessKeyId, env, "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"),
      binding: trimmed(config.binding),
      bucketName: trimmed(config.bucketName) ?? readEnv(env, "BLOB_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME", "R2_BUCKET_NAME"),
      secretAccessKey: resolveBuildRuntimeValue(config.secretAccessKey, env, "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
    { binding: "BLOB", driver: "cloudflare-r2" as const },
  )
}

function resolveVercelStore(
  config: Partial<VercelBlobStoreConfig> = {},
): ResolvedVercelBlobStoreConfig {
  return {
    ...config,
    access: config.access ?? "public",
    driver: "vercel-blob",
    token: trimmed(config.token) ?? MASKED_BLOB_RUNTIME_VALUE,
  }
}

function resolveNetlifyStore(
  config: Partial<NetlifyBlobsStoreConfig> = {},
): NetlifyBlobsStoreConfig {
  return {
    ...config,
    driver: "netlify-blobs",
    name: trimmed(config.name) ?? DEFAULT_NETLIFY_BLOBS_STORE,
  }
}

function resolveBuildRuntimeValue(
  configValue: string | undefined,
  env: Record<string, string | undefined>,
  ...envNames: string[]
): string | undefined {
  const explicit = trimmed(configValue)
  if (!explicit) return readEnv(env, ...envNames) ? MASKED_BLOB_RUNTIME_VALUE : undefined
  return envNames.some(name => trimmed(env[name]) === explicit) ? MASKED_BLOB_RUNTIME_VALUE : explicit
}

function resolveMinioStore(
  config: Partial<MinioBlobStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedMinioBlobStoreConfig {
  return {
    ...config,
    accessKeyId: resolveBuildRuntimeValue(config.accessKeyId, env, ...MINIO_ACCESS_KEY_ENV),
    bucket: trimmed(config.bucket) ?? readEnv(env, "BLOB_BUCKET_NAME", "MINIO_BUCKET", "MINIO_BUCKET_NAME") ?? DEFAULT_MINIO_BUCKET,
    driver: "minio",
    endpoint: trimmed(config.endpoint) ?? readEnv(env, "MINIO_ENDPOINT") ?? DEFAULT_MINIO_ENDPOINT,
    forcePathStyle: config.forcePathStyle ?? true,
    region: trimmed(config.region) ?? readEnv(env, "MINIO_REGION", "AWS_REGION") ?? DEFAULT_MINIO_REGION,
    secretAccessKey: resolveBuildRuntimeValue(config.secretAccessKey, env, ...MINIO_SECRET_KEY_ENV),
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
      return resolveFsStore(store, env)
    case "minio":
      return resolveMinioStore(store, env)
    case "netlify-blobs":
      return resolveNetlifyStore(store)
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

function normalizeServeHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return
  if (!isPlainObject(value)) throw new TypeError("`blob.serve.headers` must be a plain object.")

  const entries = Object.entries(value)
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string") throw new TypeError("`blob.serve.headers` values must be strings.")
    try {
      new Headers({ [name]: headerValue })
    }
    catch {
      throw new TypeError(`\`blob.serve.headers\` contains an invalid HTTP header: ${JSON.stringify(name)}.`)
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

function normalizeServeOptions(value: BlobServeOptions | undefined): ResolvedBlobModuleOptions["serve"] {
  if (value === undefined || value === false) return
  if (value === true) return { route: DEFAULT_BLOB_SERVE_ROUTE, store: "default" }
  if (!isPlainObject(value)) throw new TypeError("`blob.serve` must be true or a plain object.")
  const headers = normalizeServeHeaders(value.headers)
  return {
    ...(headers ? { headers } : {}),
    route: trimmed(value.route) || DEFAULT_BLOB_SERVE_ROUTE,
    store: trimmed(value.store) || "default",
    ...(trimmed(value.publicBaseUrl) ? { publicBaseUrl: trimmed(value.publicBaseUrl) } : {}),
  }
}

function assertServeStore(
  serve: ResolvedBlobModuleOptions["serve"],
  stores: Record<string, ResolvedBlobModuleOptions["store"]>,
): void {
  if (!serve || serve.store in stores) return
  throw new TypeError(`\`blob.serve.store\` must reference a configured Blob store: ${JSON.stringify(serve.store)}.`)
}

function createResolvedConfig(
  store: ResolvedBlobModuleOptions["store"],
  stores?: Record<string, ResolvedBlobModuleOptions["store"]>,
  serve?: ResolvedBlobModuleOptions["serve"],
): ResolvedBlobModuleOptions {
  assertServeStore(serve, stores ? { default: store, ...stores } : { default: store })
  return stores
    ? { store, stores: { default: store, ...stores }, ...(serve ? { serve } : {}) }
    : { store, ...(serve ? { serve } : {}) }
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
  const optionRecord = options as { serve?: BlobServeOptions } | undefined
  const serve = normalizeServeOptions(optionRecord?.serve)
  const { serve: _serve, ...storeOptions } = options || {}
  const implicitCloudflare = storeOptions as Partial<CloudflareR2BlobStoreConfig> | undefined

  if (hasStoresConfig(options)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(options.stores).map(([name, store]) => [name, resolveExplicitStore(store, env)]),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw new TypeError("`blob.stores.default` is required when using named Blob stores.")
    return createResolvedConfig(defaultStore, resolvedStores, serve)
  }

  if (explicit?.driver) {
    return createResolvedConfig(resolveExplicitStore(storeOptions as unknown as BlobStoreConfig, env), undefined, serve)
  }

  if (hosting.includes("cloudflare")) {
    return createResolvedConfig(resolveCloudflareStore(implicitCloudflare, env), undefined, serve)
  }

  if (hosting.includes("netlify")) {
    return createResolvedConfig(resolveNetlifyStore(), undefined, serve)
  }

  if (hasVercelBlobEnv(env)) {
    return createResolvedConfig(resolveVercelStore(), undefined, serve)
  }

  if (hosting.includes("vercel")) {
    return createResolvedConfig(resolveVercelStore(), undefined, serve)
  }

  return createResolvedConfig(resolveFsStore({}, env), undefined, serve)
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

export function resolveRuntimeMinioBlobStore(
  config: ResolvedMinioBlobStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedMinioBlobStoreConfig {
  const accessKeyId = isMaskedBlobRuntimeValue(config.accessKeyId)
    ? readEnv(env, ...MINIO_ACCESS_KEY_ENV) || config.accessKeyId
    : config.accessKeyId
  const secretAccessKey = isMaskedBlobRuntimeValue(config.secretAccessKey)
    ? readEnv(env, ...MINIO_SECRET_KEY_ENV) || config.secretAccessKey
    : config.secretAccessKey

  if (isMaskedBlobRuntimeValue(accessKeyId)) {
    throw new Error("Missing runtime environment variable `MINIO_ACCESS_KEY_ID`, `MINIO_ACCESS_KEY`, `MINIO_ROOT_USER`, or `AWS_ACCESS_KEY_ID` for MinIO Blob.")
  }

  if (isMaskedBlobRuntimeValue(secretAccessKey)) {
    throw new Error("Missing runtime environment variable `MINIO_SECRET_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_ROOT_PASSWORD`, or `AWS_SECRET_ACCESS_KEY` for MinIO Blob.")
  }

  return {
    ...config,
    accessKeyId,
    secretAccessKey,
  }
}
