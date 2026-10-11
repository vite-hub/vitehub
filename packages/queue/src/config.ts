import { defu } from "defu"

import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueModuleOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

interface QueueResolutionInput {
  hosting?: string
}

const knownProviders = new Set(["cloudflare", "vercel"])

function readOwnOption(options: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(options, key) ? options[key] : undefined
}

function resolveProvider(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const cache = readOwnOption(options, "cache")
  const binding = readOwnOption(options, "binding")
  const namePrefix = readOwnOption(options, "namePrefix")
  const region = readOwnOption(options, "region")
  const shared: QueueSharedOptions = typeof cache === "boolean" ? { cache } : {}
  const provider = readOwnOption(options, "provider")

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw queueErrorDiagnostics.QUEUE_C0001({ message: `Unknown \`queue.provider\`: ${JSON.stringify(provider)}. Expected "cloudflare" or "vercel".` })
  }

  if (typeof provider === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel")) {
    throw queueErrorDiagnostics.QUEUE_C0002({ message: "`queue.provider` cannot be inferred for " + hosting + " hosting. Disable `queue` or select the Cloudflare or Vercel deployment preset." })
  }

  const resolved = provider || (hosting.includes("cloudflare") ? "cloudflare" : "vercel")

  if (resolved === "cloudflare") {
    return defu(
      {
        ...(typeof binding === "string" ? { binding } : {}),
        ...(typeof namePrefix === "string" ? { namePrefix } : {}),
      },
      shared,
      { provider: "cloudflare" as const },
    )
  }

  return defu(
    typeof region === "string" ? { region } : {},
    shared,
    { provider: "vercel" as const },
  )
}

export function normalizeQueueOptions(options: QueueModuleOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw queueErrorDiagnostics.QUEUE_C0003({ message: "`queue` must be a plain object." })
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting))
}
