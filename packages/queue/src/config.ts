import type {
  QueueModuleProviderOptions,
  QueueModuleOptions,
  ResolvedQueueModuleOptions,
  ResolvedQueueModuleProviderOptions,
} from "./types.ts"

export interface QueueResolutionInput {
  hosting?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function resolveProvider(
  provider: QueueModuleProviderOptions | (Record<string, unknown> & { provider?: undefined }),
  hosting = "",
): ResolvedQueueModuleProviderOptions {
  const explicit = provider.provider
  if (explicit === "cloudflare" || explicit === "vercel" || explicit === "memory") {
    return { ...provider, provider: explicit } as ResolvedQueueModuleProviderOptions
  }
  if (typeof explicit !== "undefined") {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(explicit)}. Expected "cloudflare", "vercel", or "memory".`)
  }

  const shared = typeof provider.cache === "boolean" ? { cache: provider.cache } : {}
  const inferred = hosting.includes("cloudflare") ? "cloudflare" : hosting.includes("vercel") ? "vercel" : "memory"
  return { ...shared, provider: inferred }
}

export function normalizeQueueOptions(
  options: QueueModuleOptions | undefined,
  input: QueueResolutionInput = {},
): ResolvedQueueModuleOptions | undefined {
  if (options === false) return

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`queue` must be a plain object.")
  }

  return {
    provider: resolveProvider(options || {}, input.hosting || ""),
  }
}
