import { defu } from "defu"

import { hostFromNitroPreset } from "@vite-hub/internal/deployment"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"

import type { QueueDriver, QueueOptions, QueueSharedOptions, ResolvedQueueOptions } from "./types.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

export interface QueueResolutionInput {
  hosting?: string
  /**
   * The app has a Default Database on Postgres. On a Node server without `queue.driver`, Queue then picks the
   * `postgres` driver on the connection of that Database, so every instance shares the jobs. The Queue Vite plugin
   * reads it from the resolved config of the Database integration.
   */
  postgresDatabase?: boolean
}

const knownDrivers = new Set(["cloudflare", "local", "postgres", "vercel"])

/** The variable that overrides the connection of the postgres driver at runtime. */
export const postgresQueueUrlVariable = "QUEUE_POSTGRES_URL"

/** Default directory of the local driver, next to the KV `fs-lite` store in `.vitehub/data/kv`. */
export const defaultLocalQueueBase = ".vitehub/data/queue"

/** A self-hosted Node server has no hosted Queue, so it runs Queue Definitions in its own process. */
function isLocalHosting(hosting: string): boolean {
  return hosting === "local" || hostFromNitroPreset(hosting) === "node"
}

function readOwnOption(options: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(options, key) ? options[key] : undefined
}

/** The driver without `queue.driver`: the host's Queue, or on Node `postgres` with a Postgres Database, else `local`. */
function inferDriver(hosting: string, postgresDatabase: boolean): QueueDriver {
  if (hosting.includes("cloudflare")) return "cloudflare"
  // `resolveQueueHosting()` passes the driver of a Node server as its hosting.
  if (hosting === "postgres") return "postgres"
  if (isLocalHosting(hosting)) return postgresDatabase ? "postgres" : "local"
  return "vercel"
}

function resolveDriver(options: Record<string, unknown>, hosting: string, postgresDatabase: boolean): ResolvedQueueOptions {
  const cache = readOwnOption(options, "cache")
  const shared: QueueSharedOptions = typeof cache === "boolean" ? { cache } : {}
  const driver = readOwnOption(options, "driver")

  if (typeof driver === "string" && !knownDrivers.has(driver)) {
    throw queueErrorDiagnostics.QUEUE_INVALID_DRIVER({ driver })
  }

  if (typeof driver === "undefined" && hosting && !hosting.includes("cloudflare") && !hosting.includes("vercel") && hosting !== "postgres" && !isLocalHosting(hosting)) {
    throw queueErrorDiagnostics.QUEUE_MISSING_DRIVER({ hosting })
  }

  const resolved = driver || inferDriver(hosting, postgresDatabase)

  // The jobs use the connection of the Default Database, so they live where the app's data lives.
  if (resolved === "postgres") return defu(postgresDatabase ? { database: "default" } : {}, shared, { driver: "postgres" as const })

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
  return resolveDriver(options || {}, normalizeHosting(input.hosting), input.postgresDatabase === true)
}
