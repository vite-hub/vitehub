import { getActiveCloudflareBinding, getActiveCloudflareRequestScope } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import { resolveConfigValue } from "../config-value.ts"
import { keepOwnClient, trackPostgresClient } from "./request-stats.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

import type { DatabaseConfigValue, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"

/** Build-time values that apply when the evaluated Definition omits them. */
export interface PostgresDatabaseDefaults {
  binding: string
  url?: DatabaseConfigValue
}

interface PostgresInstance<TSchema extends Record<string, unknown>> {
  client: ReturnType<typeof postgres>
  db: RuntimePostgresDatabase<TSchema>
  key: string
}

/** A connection URL, or `undefined` when postgres.js reads its PG* environment variables. */
interface PostgresConnection {
  key: string
  url?: string
}

/** The environment variables that postgres.js reads when it gets no connection URL. */
// Keep this list in sync with postgres.js' `parseOptions`: every PG* value it
// reads must participate in the cache key so environment changes replace the
// shared client instead of reusing options from the old environment.
const postgresEnvNames = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSERNAME",
  "PGUSER",
  "PGPASSWORD",
  "PGSSL",
  "PGSSLNEGOTIATION",
  "PGIDLE_TIMEOUT",
  "PGCONNECT_TIMEOUT",
  "PGMAX_LIFETIME",
  "PGMAX_PIPELINE",
  "PGBACKOFF",
  "PGKEEP_ALIVE",
  "PGPREPARE",
  "PGDEBUG",
  "PGFETCH_TYPES",
  "PGPUBLICATIONS",
  "PGAPPNAME",
  "PGTARGETSESSIONATTRS",
] as const

function readPostgresEnvKey() {
  const env = globalThis.process?.env
  const values = postgresEnvNames.map(name => env?.[name] ?? "")
  return values.some(value => value.trim().length > 0) ? JSON.stringify(values) : undefined
}

function readHyperdriveConnectionString(binding: unknown) {
  if (!binding || Object(binding) !== binding) return
  const connectionString: unknown = Reflect.get(Object(binding), "connectionString")
  return typeof connectionString === "string" && connectionString ? connectionString : undefined
}

/**
 * Creates the Drizzle client for a Postgres Database Definition.
 *
 * A Cloudflare Hyperdrive binding takes precedence over `connection.url`. Inside a Cloudflare
 * request, each request gets its own client because Workers cannot reuse a socket across requests.
 * Outside a Cloudflare request, one client pool serves the process.
 */
export function createPostgresDatabase<TSchema extends Record<string, unknown>>(
  definition: PostgresDatabaseDefinition<TSchema>,
  defaults: PostgresDatabaseDefaults,
): RuntimePostgresDatabase<TSchema> {
  const bindingName = definition.cloudflare?.binding?.trim() || defaults.binding
  const requestInstances = new WeakMap<object, PostgresInstance<TSchema>>()
  let sharedInstance: PostgresInstance<TSchema> | undefined

  function resolveConnection(requestScoped: boolean): PostgresConnection {
    const hyperdriveUrl = readHyperdriveConnectionString(getActiveCloudflareBinding<unknown>(bindingName))
    if (hyperdriveUrl) return { key: hyperdriveUrl, url: hyperdriveUrl }
    const url = resolveConfigValue(definition.connection?.url ?? defaults.url)?.trim()
    if (url) return { key: url, url }
    // The Workers build of postgres.js does not read process.env, so PG* variables apply only outside Cloudflare.
    const envKey = requestScoped ? undefined : readPostgresEnvKey()
    if (envKey) return { key: envKey }
    const needs = requestScoped
      ? `the Cloudflare Hyperdrive binding "${bindingName}" or \`connection.url\``
      : `the Cloudflare Hyperdrive binding "${bindingName}", \`connection.url\`, or PG* environment variables such as \`PGHOST\``
    throw databaseErrorDiagnostics.DATABASE_MISSING_CONNECTION({ database: definition.name, needs })
  }

  function createInstance(connection: PostgresConnection, requestScoped: boolean): PostgresInstance<TSchema> {
    // Cloudflare limits concurrent connections per request. Hyperdrive pools the origin connections.
    // Type discovery stays on, because array columns need the type metadata that postgres.js reads.
    const options = requestScoped ? { max: 5 } : {}
    const client = connection.url ? postgres(connection.url, options) : postgres(options)
    const db: RuntimePostgresDatabase<TSchema> = keepOwnClient(drizzle({ casing: definition.drizzle.casing, client: trackPostgresClient(client), schema: definition.schema }), client)
    return { client, db, key: connection.key }
  }

  function getDb() {
    const scope = getActiveCloudflareRequestScope()
    const connection = resolveConnection(Boolean(scope))
    if (scope) {
      const cached = requestInstances.get(scope)
      if (cached?.key === connection.key) return cached.db
      const instance = createInstance(connection, true)
      requestInstances.set(scope, instance)
      return instance.db
    }

    if (sharedInstance?.key === connection.key) return sharedInstance.db
    const previous = sharedInstance
    sharedInstance = createInstance(connection, false)
    // end() lets queries that already started finish before it closes the superseded pool.
    void previous?.client.end()
    return sharedInstance.db
  }

  // SAFETY: Every property read forwards to the Drizzle database for the active request or process.
  return new Proxy({} as RuntimePostgresDatabase<TSchema>, {
    get(_, property) {
      const instance = getDb()
      const value: unknown = Reflect.get(instance, property)
      // Bind Drizzle methods. Own function values such as the postgres.js `$client` keep their properties.
      return typeof value === "function" && !Object.hasOwn(instance, property) ? value.bind(instance) : value
    },
  })
}
