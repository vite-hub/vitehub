import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueModuleOptions, ResolvedQueueModuleProviderOptions } from "./types.ts"

export interface QueueResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function cloneSharedOptions(input: QueueSharedOptions | undefined) {
  const shared: QueueSharedOptions = {}
  if (typeof input?.cache === "boolean") {
    shared.cache = input.cache
  }
  return shared
}

function normalizeHosting(hosting: string | undefined) {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueModuleProviderOptions {
  const provider = options.provider
  if (typeof provider === "string") {
    if (!knownProviders.has(provider)) {
      throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`)
    }

    if (provider === "cloudflare") {
      return {
        ...cloneSharedOptions(options as QueueSharedOptions),
        ...typeof options.binding === "string" ? { binding: options.binding } : {},
        provider: "cloudflare",
      }
    }

    return {
      ...cloneSharedOptions(options as QueueSharedOptions),
      ...typeof options.region === "string" ? { region: options.region } : {},
      provider: "vercel",
    }
  }

  if (hosting.includes("cloudflare")) {
    return {
      ...cloneSharedOptions(options as QueueSharedOptions),
      provider: "cloudflare",
    }
  }

  return {
    ...cloneSharedOptions(options as QueueSharedOptions),
    ...typeof options.region === "string" ? { region: options.region } : {},
    provider: "vercel",
  }
}

export function normalizeQueueOptions(options: QueueModuleOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueModuleOptions | undefined {
  if (options === false) {
    return undefined
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`queue` must be a plain object.")
  }

  return {
    provider: resolveProvider(options || {}, normalizeHosting(input.hosting)),
  }
}
