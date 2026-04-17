import type {
  QueueModuleOptions,
  QueueProviderOptions,
  ResolvedQueueModuleOptions,
} from "./types.ts"

export interface QueueResolutionInput {
  hosting?: string
}

const KNOWN_PROVIDERS = new Set(["cloudflare", "memory", "vercel"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function resolveProvider(
  provider: QueueProviderOptions | (Record<string, unknown> & { provider?: undefined }),
  hosting = "",
): QueueProviderOptions {
  if (provider.provider) {
    if (!KNOWN_PROVIDERS.has(provider.provider)) {
      throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider.provider)}. Expected "cloudflare", "vercel", or "memory".`)
    }
    return { ...provider } as QueueProviderOptions
  }

  const shared: { cache?: boolean } = {}
  if (typeof provider.cache === "boolean") shared.cache = provider.cache
  if (hosting.includes("cloudflare")) return { ...shared, provider: "cloudflare" }
  if (hosting.includes("vercel")) return { ...shared, provider: "vercel" }
  return { ...shared, provider: "memory" }
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
