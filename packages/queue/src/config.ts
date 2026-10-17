import { defu } from "defu"

import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

interface QueueResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const shared: QueueSharedOptions = typeof options.cache === "boolean" ? { cache: options.cache } : {}
  const provider = options.provider

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_PROVIDER({ provider })
  }

  if (typeof provider === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel")) {
    throw queueErrorDiagnostics.QUEUE_MISSING_PROVIDER({ hosting })
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
    throw queueErrorDiagnostics.QUEUE_INVALID_CONFIG()
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
