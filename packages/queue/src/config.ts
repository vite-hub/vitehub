import { defu } from "defu"

import { deploymentPresetFromNitro } from "@vite-hub/internal/deployment"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

interface QueueResolutionInput {
  hosting?: string
}

const knownDrivers = new Set(["cloudflare", "local", "vercel"])

/** Default directory of the local driver, next to the KV `fs-lite` store in `.vitehub/data/kv`. */
export const defaultLocalQueueBase = ".vitehub/data/queue"

/** A self-hosted Node server has no hosted Queue, so it runs Queue Definitions in its own process. */
function isLocalHosting(hosting: string): boolean {
  return hosting === "local" || deploymentPresetFromNitro(hosting) === "node"
}

function readOwnOption(options: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(options, key) ? options[key] : undefined
}

function resolveDriver(options: Record<string, unknown>, hosting: string): ResolvedQueueOptions {
  const cache = readOwnOption(options, "cache")
  const shared: QueueSharedOptions = typeof cache === "boolean" ? { cache } : {}
  const driver = readOwnOption(options, "driver")

  if (typeof driver === "string" && !knownDrivers.has(driver)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_DRIVER({ driver })
  }

  if (typeof driver === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel") && !isLocalHosting(hosting)) {
    throw queueErrorDiagnostics.QUEUE_MISSING_DRIVER({ hosting })
  }

  const resolved = driver || (hosting.includes("cloudflare") ? "cloudflare" : isLocalHosting(hosting) ? "local" : "vercel")

  if (resolved === "local") {
    const base = readOwnOption(options, "base")
    return defu(
      typeof base === "string" && base.trim() ? { base: base.trim() } : {},
      shared,
      { base: defaultLocalQueueBase, driver: "local" as const },
    )
  }

  if (resolved === "cloudflare") {
    const binding = readOwnOption(options, "binding")
    const namePrefix = readOwnOption(options, "namePrefix")
    return defu(
      {
        ...(typeof binding === "string" ? { binding } : {}),
        ...(typeof namePrefix === "string" ? { namePrefix } : {}),
      },
      shared,
      { driver: "cloudflare" as const },
    )
  }

  const region = readOwnOption(options, "region")
  return defu(
    typeof region === "string" ? { region } : {},
    shared,
    { driver: "vercel" as const },
  )
}

export function normalizeQueueOptions(options: QueueOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_CONFIG()
  }
  return resolveDriver(options || {}, normalizeHosting(input.hosting))
}
