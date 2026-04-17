import type {
  QueueModuleOptions,
  QueueProviderOptions,
  ResolvedQueueModuleOptions,
  ResolvedQueueProviderOptions,
} from "./types.ts"

export interface QueueResolutionInput {
  hosting?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function resolveProvider(
  provider: QueueProviderOptions | (Record<string, unknown> & { provider?: undefined }),
  hosting = "",
): ResolvedQueueProviderOptions {
  if (provider.provider === "cloudflare") return { ...provider, provider: "cloudflare" }
  if (provider.provider === "vercel") return { ...provider, provider: "vercel" }
  if (provider.provider === "memory") return { ...provider, provider: "memory" }
  const unknownProvider = (provider as { provider?: unknown }).provider
  if (typeof unknownProvider !== "undefined") {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(unknownProvider)}. Expected "cloudflare", "vercel", or "memory".`)
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
