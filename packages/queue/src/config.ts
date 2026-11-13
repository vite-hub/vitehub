import { defu } from "defu"

import { hostFromNitroPreset } from "@vite-hub/internal/deployment"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueOptions, QueueProvider, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

export interface QueueResolutionInput {
  hosting?: string
  /**
   * The app has a Default Database on Postgres. On a Node server without `queue.provider`, Queue then picks the
   * `postgres` provider on the connection of that Database, so every instance shares the jobs. The Queue Vite plugin
   * reads it from the resolved config of the Database integration.
   */
  postgresDatabase?: boolean
}

const knownProviders = new Set(["cloudflare", "local", "postgres", "vercel"])

/** The variable that overrides the connection of the postgres provider at runtime. */
export const postgresQueueUrlVariable = "QUEUE_POSTGRES_URL"

/** Default directory of the local provider, next to the KV `fs-lite` store in `.vitehub/data/kv`. */
export const defaultLocalQueueBase = ".vitehub/data/queue"

/** A self-hosted Node server has no hosted Queue, so it runs Queue Definitions in its own process. */
function isLocalHosting(hosting: string): boolean {
  return hosting === "local" || hostFromNitroPreset(hosting) === "node"
}

function readOwnOption(options: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(options, key) ? options[key] : undefined
}

/** The provider without `queue.provider`: the host's Queue, or on Node `postgres` with a Postgres Database, else `local`. */
function inferProvider(hosting: string, postgresDatabase: boolean): QueueProvider {
  if (hosting.includes("cloudflare")) return "cloudflare"
  // `resolveQueueHosting()` passes the provider of a Node server as its hosting.
  if (hosting === "postgres") return "postgres"
  if (isLocalHosting(hosting)) return postgresDatabase ? "postgres" : "local"
  return "vercel"
}

function resolveProvider(options: Record<string, unknown>, hosting: string, postgresDatabase: boolean): ResolvedQueueOptions {
  const cache = readOwnOption(options, "cache")
  const shared: QueueSharedOptions = typeof cache === "boolean" ? { cache } : {}
  const provider = readOwnOption(options, "provider")

  if (typeof provider === "string" && !knownProviders.has(provider)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_PROVIDER({ provider })
  }

  if (typeof provider === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel") && hosting !== "postgres" && !isLocalHosting(hosting)) {
    throw queueErrorDiagnostics.QUEUE_MISSING_PROVIDER({ hosting })
  }

  const resolved = provider || inferProvider(hosting, postgresDatabase)

  // The jobs use the connection of the Default Database, so they live where the app's data lives.
  if (resolved === "postgres") return defu(postgresDatabase ? { database: "default" } : {}, shared, { provider: "postgres" as const })

  if (resolved === "local") {
    const base = readOwnOption(options, "base")
    return defu(
      typeof base === "string" && base.trim() ? { base: base.trim() } : {},
      shared,
      { base: defaultLocalQueueBase, provider: "local" as const },
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
      { provider: "cloudflare" as const },
    )
  }

  const region = readOwnOption(options, "region")
  return defu(
    typeof region === "string" ? { region } : {},
    shared,
    { provider: "vercel" as const },
  )
}

export function normalizeQueueOptions(options: QueueOptions | undefined, input: QueueResolutionInput = {}): ResolvedQueueOptions | undefined {
  if (options === false) return undefined
  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_CONFIG()
  }
  return resolveProvider(options || {}, normalizeHosting(input.hosting), input.postgresDatabase === true)
}
