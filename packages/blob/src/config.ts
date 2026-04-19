import type {
  BlobModuleOptions,
  BlobProviderConfig,
  CloudflareR2BlobConfig,
  ResolvedBlobModuleOptions,
  ResolvedBlobProviderConfig,
  VercelBlobConfig,
} from "./types.ts"

export interface BlobResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim()
  return value || undefined
}

function resolveCloudflareR2Provider(
  provider: Partial<CloudflareR2BlobConfig> = {},
): ResolvedBlobProviderConfig {
  return {
    ...provider,
    binding: provider.binding?.trim() || "BLOB",
    driver: "cloudflare-r2",
  }
}

function resolveVercelBlobProvider(
  provider: Partial<VercelBlobConfig> = {},
): ResolvedBlobProviderConfig {
  return {
    ...provider,
    access: "public",
    driver: "vercel-blob",
    token: provider.token,
  }
}

function resolveExplicitProvider(
  provider: BlobProviderConfig,
): ResolvedBlobProviderConfig {
  if (provider.driver === "cloudflare-r2") return { ...resolveCloudflareR2Provider(provider), source: "explicit" }
  if (provider.driver === "vercel-blob") return { ...resolveVercelBlobProvider(provider), source: "explicit" }

  const unknownProvider = (provider as { driver?: unknown }).driver
  throw new TypeError(`Unknown \`blob.driver\`: ${JSON.stringify(unknownProvider)}. Expected "cloudflare-r2" or "vercel-blob".`)
}

export function normalizeBlobOptions(
  options: BlobModuleOptions | undefined,
  input: BlobResolutionInput = {},
): ResolvedBlobModuleOptions | undefined {
  if (options === false) return

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`blob` must be a plain object.")
  }

  const env = input.env || process.env
  const hosting = input.hosting || ""
  const explicit = options as BlobProviderConfig | undefined

  if (explicit?.driver) return { provider: resolveExplicitProvider(explicit) }
  if (hosting.includes("cloudflare")) return { provider: { ...resolveCloudflareR2Provider(), source: "auto" } }
  if (hosting.includes("vercel") || readEnv(env, "BLOB_READ_WRITE_TOKEN")) {
    return { provider: { ...resolveVercelBlobProvider({}), source: "auto" } }
  }

  return
}
