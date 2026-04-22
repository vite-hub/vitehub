import { defu } from "defu"

import { readEnv, trimmed } from "./internal/env.ts"

import type {
  BlobModuleOptions,
  BlobStoreConfig,
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

const maskedBlobRuntimeValue = "********"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

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
    token: trimmed(config.token) ?? maskedBlobRuntimeValue,
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
    default:
      throw new TypeError(`Unknown \`blob.driver\`: ${JSON.stringify((store as { driver: unknown }).driver)}. Expected "cloudflare-r2", "fs", or "vercel-blob".`)
  }
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
  const hosting = input.hosting || ""
  const explicit = options as BlobStoreConfig | undefined

  if (explicit?.driver) {
    return { store: resolveExplicitStore(explicit, env) }
  }

  if (hasVercelBlobEnv(env)) {
    return { store: resolveVercelStore() }
  }

  if (hosting.includes("vercel")) {
    return { store: resolveVercelStore() }
  }

  if (hosting.includes("cloudflare")) {
    return { store: resolveCloudflareStore({}, env) }
  }

  return { store: resolveFsStore() }
}

export function warnVercelBlobFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedBlobModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !hosting?.includes("vercel") || config.store.driver !== "fs") {
    return
  }

  target.logger?.error?.(
    "Vercel hosting requires Vercel Blob-backed storage. Set `BLOB_READ_WRITE_TOKEN`.",
  )
}

export function isMaskedBlobRuntimeValue(value: string | undefined): boolean {
  return !value || /^\*+$/.test(value)
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
