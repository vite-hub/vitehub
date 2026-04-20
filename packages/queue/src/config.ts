import { normalizeHosting } from "./internal/hosting.ts"

import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"

interface QueueResolutionInput {
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

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const shared = cloneSharedOptions(options as QueueSharedOptions)
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`)
  }

  const resolved = provider || (hosting.includes("cloudflare") ? "cloudflare" : "vercel")

  if (resolved === "cloudflare") {
    return {
      ...shared,
      ...typeof options.binding === "string" ? { binding: options.binding } : {},
      provider: "cloudflare",
    }
  }

  return {
    ...shared,
    ...typeof options.region === "string" ? { region: options.region } : {},
    provider: "vercel",
  }
}

export function normalizeQueueOptions(options: QueueModuleOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueOptions | undefined {
  if (options === false) {
    return undefined
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`queue` must be a plain object.")
  }

  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
