import { defu } from "defu"

import { isPlainObject } from "@vitehub/internal/object"

import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"

interface QueueResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function normalizeHosting(hosting: string | undefined): string {
  return hosting?.trim().toLowerCase().replaceAll("_", "-") || ""
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const shared: QueueSharedOptions = typeof options.cache === "boolean" ? { cache: options.cache } : {}
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`)
  }

  const resolved = provider || (hosting.includes("cloudflare") ? "cloudflare" : "vercel")

  if (resolved === "cloudflare") {
    return defu(
      typeof options.binding === "string" ? { binding: options.binding } : {},
      shared,
      { provider: "cloudflare" as const },
    )
  }

  return defu(
    typeof options.region === "string" ? { region: options.region } : {},
    shared,
    { provider: "vercel" as const },
  )
}

export function normalizeQueueOptions(options: QueueModuleOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`queue` must be a plain object.")
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
