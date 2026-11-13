import { getActiveCloudflareBinding, getActiveCloudflareRequestScope } from "@vite-hub/internal/runtime/cloudflare-env"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { readPostgresEnvKey } from "./postgres-env.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseConfigValue, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"

/** Build-time values that apply when the evaluated Definition omits them. */
export interface PostgresDatabaseDefaults {
  binding: string
  url?: DatabaseConfigValue
}

/** One open client of a Postgres driver, with the Drizzle database on it. */
export interface PostgresDriverClient<TSchema extends Record<string, unknown>, TRelations extends AnyRelations> {
  db: RuntimePostgresDatabase<TSchema, TRelations>
  /** Lets queries that already started finish, then closes the client. */
  end: () => unknown
}

/**
 * Opens a client of one Postgres driver: postgres.js or node-postgres. Without `url`, the driver reads the PG*
 * environment variables. `requestScoped` is true inside a Cloudflare request, which limits concurrent connections.
 */
export type PostgresDriverConnect = <TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  options: { relations: TRelations, requestScoped: boolean, url?: string },
) => PostgresDriverClient<TSchema, TRelations>

interface PostgresInstance<TSchema extends Record<string, unknown>, TRelations extends AnyRelations> {
  client: PostgresDriverClient<TSchema, TRelations>
  key: string
}

/** A connection URL, or `undefined` when postgres.js reads its PG* environment variables. */
interface PostgresConnection {
  key: string
  url?: string
}

/** A database that serves a Postgres Definition without a server. The development runtime passes PGlite. */
export interface LocalPostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations> {
  /** True for `driver: "pglite"`: the local database serves every query, even with a URL or PG* variables. */
  always: boolean
  /** Returns the database for the current query. In app tests, it changes after each reset. */
  get: () => RuntimePostgresDatabase<TSchema, TRelations>
}

function readHyperdriveConnectionString(binding: unknown) {
  if (!binding || Object(binding) !== binding) return
  const connectionString: unknown = Reflect.get(Object(binding), "connectionString")
  return typeof connectionString === "string" && connectionString ? connectionString : undefined
}

/**
 * Receives the notices of the server. postgres.js prints each one on stdout by default, so every `CREATE ... IF NOT
 * EXISTS` that KV, leases or Queue run at boot printed a NOTICE object. This drops notices and keeps warnings visible.
 * Errors are not notices: they reject the query.
 */
export function printPostgresWarning(notice: { message?: string, severity?: string }) {
  if (notice.severity === "WARNING") console.warn(`[vitehub] Postgres warning: ${notice.message}`)
}

/**
 * Creates the Drizzle client for a Postgres Database Definition with the client of one driver.
 *
 * A Cloudflare Hyperdrive binding takes precedence over `connection.url`. Inside a Cloudflare
 * request, each request gets its own client because Workers cannot reuse a socket across requests.
 * Outside a Cloudflare request, one client pool serves the process. Without any connection, `local` serves the queries.
 */
export function createDriverPostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  connect: PostgresDriverConnect,
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  defaults: PostgresDatabaseDefaults,
  local?: LocalPostgresDatabase<TSchema, TRelations>,
): RuntimePostgresDatabase<TSchema, TRelations> {
  const bindingName = definition.cloudflare?.binding?.trim() || defaults.binding
  const requestInstances = new WeakMap<object, PostgresInstance<TSchema, TRelations>>()
  let sharedInstance: PostgresInstance<TSchema, TRelations> | undefined
  // Every table of the schema, with the relations of the Definition, so `db.query.<table>` reads each one.
  const { relations } = definition

  function resolveConnection(requestScoped: boolean): PostgresConnection | undefined {
    const hyperdriveUrl = readHyperdriveConnectionString(getActiveCloudflareBinding<unknown>(bindingName))
    if (hyperdriveUrl) return { key: hyperdriveUrl, url: hyperdriveUrl }
    const url = resolveConfigValue(definition.connection?.url ?? defaults.url)?.trim()
    if (url) return { key: url, url }
    // The Workers build of postgres.js does not read process.env, so PG* variables apply only outside Cloudflare.
    const envKey = requestScoped ? undefined : readPostgresEnvKey()
    if (envKey) return { key: envKey }
  }

  function createInstance(connection: PostgresConnection, requestScoped: boolean): PostgresInstance<TSchema, TRelations> {
    return { client: connect<TSchema, TRelations>({ relations, requestScoped, ...connection.url ? { url: connection.url } : {} }), key: connection.key }
  }

  function getDb() {
    if (local?.always) return local.get()
    const scope = getActiveCloudflareRequestScope()
    const connection = resolveConnection(Boolean(scope))
    if (!connection) {
      if (local) return local.get()
      const needs = scope
        ? `the Cloudflare Hyperdrive binding "${bindingName}" or \`connection.url\``
        : `the Cloudflare Hyperdrive binding "${bindingName}", \`connection.url\`, or PG* environment variables such as \`PGHOST\``
      throw databaseErrorDiagnostics.DATABASE_MISSING_CONNECTION({ database: definition.name, needs })
    }
    if (scope) {
      const cached = requestInstances.get(scope)
      if (cached?.key === connection.key) return cached.client.db
      const instance = createInstance(connection, true)
      requestInstances.set(scope, instance)
      return instance.client.db
    }

    if (sharedInstance?.key === connection.key) return sharedInstance.client.db
    const previous = sharedInstance
    sharedInstance = createInstance(connection, false)
    // end() lets queries that already started finish before it closes the superseded pool.
    void previous?.client.end()
    return sharedInstance.client.db
  }

  // SAFETY: Every property read forwards to the Drizzle database for the active request or process.
  return new Proxy({} as RuntimePostgresDatabase<TSchema, TRelations>, {
    get(_, property) {
      // The database is not a promise. `await` reads `then`, which must not open a client.
      if (property === "then") return
      const instance = getDb()
      const value: unknown = Reflect.get(instance, property)
      // Bind Drizzle methods. Own function values such as the postgres.js `$client` keep their properties.
      return typeof value === "function" && !Object.hasOwn(instance, property) ? value.bind(instance) : value
    },
    // Drizzle's `is()` reads the prototype, so `is(db, PgAsyncDatabase)` sees the live database.
    getPrototypeOf: () => Object.getPrototypeOf(getDb()),
  })
}
