import { defu } from "defu"

import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"

interface QueueResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const shared: QueueSharedOptions = typeof options.cache === "boolean" ? { cache: options.cache } : {}
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw new TypeError(`Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".`)
  }

  if (typeof provider === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel")) {
    throw new TypeError("`queue.provider` cannot be inferred for " + hosting + " hosting. Disable `queue` or select the Cloudflare or Vercel deployment preset.")
  }

  const resolved = provider || (hosting.includes("cloudflare") ? "cloudflare" : "vercel")

  if (resolved === "cloudflare") {
    return defu(
      {
        ...(typeof options.binding === "string" ? { binding: options.binding } : {}),
        ...(typeof options.namePrefix === "string" ? { namePrefix: options.namePrefix } : {}),
      },
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
