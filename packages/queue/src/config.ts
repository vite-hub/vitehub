import type {
  InternalResolvedQueueModuleProviderOptions,
  QueueModuleProviderOptions,
  QueueModuleOptions,
  ResolvedQueueModuleOptions,
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
): InternalResolvedQueueModuleProviderOptions {
  if (provider.provider === "cloudflare") return { ...provider, provider: "cloudflare" }
  if (provider.provider === "vercel") return { ...provider, provider: "vercel" }
  const unknownProvider = (provider as { provider?: unknown }).provider
  if (typeof unknownProvider !== "undefined") {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(unknownProvider)}. Expected "cloudflare" or "vercel".`)
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
