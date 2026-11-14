import { getActiveCloudflareBinding, getActiveCloudflareRequestScope } from "@vite-hub/internal/runtime/cloudflare-env"
// Both Postgres drivers already load this module. The `drizzle-orm/pg-core` index would load every column type at startup.
import { withReplicas } from "drizzle-orm/pg-core/async/db"

import { resolveConfigValue } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { readPostgresEnvKey } from "./postgres-env.ts"
import { keepOwnClient } from "./request-stats.ts"

import type { AnyRelations } from "drizzle-orm"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { DatabaseConfigValue, PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"

/** A Drizzle database without `$replica`. The client proxy adds it. */
export type PostgresDrizzle<TRelations extends AnyRelations> = PgAsyncDatabase<PgQueryResultHKT, TRelations>

/** Build-time values that apply when the evaluated Definition omits them. */
export interface PostgresDatabaseDefaults {
  binding: string
  url?: DatabaseConfigValue
}

/** One open client of a Postgres driver, with the Drizzle database on it. */
export interface PostgresDriverClient<TRelations extends AnyRelations> {
  db: PostgresDrizzle<TRelations>
  /** Lets queries that already started finish, then closes the client. */
  end: () => unknown
}

/**
 * Opens a client of one Postgres driver: postgres.js or node-postgres. Without `url`, the driver reads the PG*
 * environment variables. `requestScoped` is true inside a Cloudflare request, which limits concurrent connections.
 */
export type PostgresDriverConnect = <TRelations extends AnyRelations>(
  options: { relations: TRelations, requestScoped: boolean, url?: string },
) => PostgresDriverClient<TRelations>

interface PostgresInstance<TRelations extends AnyRelations> {
  /** The primary client, then one client per replica. */
  clients: Array<PostgresDriverClient<TRelations>>
  db: PostgresDrizzle<TRelations>
  key: string
}

/** A connection URL, or `undefined` when the driver reads its PG* environment variables. */
interface PostgresConnection {
  key: string
  /** Read replica URLs. Empty under Hyperdrive. */
  replicas: string[]
  url?: string
}

/** A database that serves a Postgres Definition without a server. The development runtime passes PGlite. */
export interface LocalPostgresDatabase<TRelations extends AnyRelations> {
  /** True for `driver: "pglite"`: the local database serves every query, even with a URL or PG* variables. */
  always: boolean
  /** Returns the database for the current query. In app tests, it changes after each reset. */
  get: () => PostgresDrizzle<TRelations>
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
 * A Cloudflare Hyperdrive binding takes precedence over `connection.url`. With `connection.replicas`, the database
 * comes from Drizzle's `withReplicas()`, and `db.$replica` reads from one replica. Hyperdrive has one origin, so it
 * skips the replicas, and so does the local database. Then `db.$replica` is the database itself. Inside a Cloudflare
 * request, each request gets its own client because Workers cannot reuse a socket across requests.
 * Outside a Cloudflare request, one client pool serves the process. Without any connection, `local` serves the queries.
 */
export function createDriverPostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  connect: PostgresDriverConnect,
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  defaults: PostgresDatabaseDefaults,
  local?: LocalPostgresDatabase<TRelations>,
): RuntimePostgresDatabase<TSchema, TRelations> {
  const bindingName = definition.cloudflare?.binding?.trim() || defaults.binding
  const requestInstances = new WeakMap<object, PostgresInstance<TRelations>>()
  let sharedInstance: PostgresInstance<TRelations> | undefined
  let warnedHyperdriveReplicas = false
  // Every table of the schema, with the relations of the Definition, so `db.query.<table>` reads each one.
  const { relations } = definition

  function resolveReplicas(): string[] {
    return (definition.connection?.replicas ?? []).map(replica => resolveConfigValue(replica)?.trim()).filter((url): url is string => !!url)
  }

  function resolveConnection(requestScoped: boolean): PostgresConnection | undefined {
    const hyperdriveUrl = readHyperdriveConnectionString(getActiveCloudflareBinding<unknown>(bindingName))
    if (hyperdriveUrl) {
      if (!warnedHyperdriveReplicas && resolveReplicas().length) {
        warnedHyperdriveReplicas = true
        console.warn(`[vitehub] Database "${definition.name}" uses the Hyperdrive binding "${bindingName}", which has one origin, so it ignores \`connection.replicas\`. \`db.$replica\` queries the Hyperdrive origin.`)
      }
      return { key: hyperdriveUrl, replicas: [], url: hyperdriveUrl }
    }
    const replicas = resolveReplicas()
    // Replicas change the client, so they are part of the cache key.
    const replicaKey = replicas.length ? `\n${replicas.join("\n")}` : ""
    const url = resolveConfigValue(definition.connection?.url ?? defaults.url)?.trim()
    if (url) return { key: `${url}${replicaKey}`, replicas, url }
    // The Workers build of postgres.js does not read process.env, so PG* variables apply only outside Cloudflare.
    const envKey = requestScoped ? undefined : readPostgresEnvKey()
    if (envKey) return { key: `${envKey}${replicaKey}`, replicas }
  }

  function createInstance(connection: PostgresConnection, requestScoped: boolean): PostgresInstance<TRelations> {
    const primary = connect<TRelations>({ relations, requestScoped, ...connection.url ? { url: connection.url } : {} })
    const replicas = connection.replicas.map(url => connect<TRelations>({ relations, requestScoped, url }))
    const [first, ...rest] = replicas.map(replica => replica.db)
    // `withReplicas()` inherits from the primary. Its own `$client` keeps the proxy from binding the driver client.
    const db = first ? keepOwnClient(withReplicas(primary.db, [first, ...rest]), Reflect.get(primary.db, "$client")) : primary.db
    return { clients: [primary, ...replicas], db, key: connection.key }
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
      if (cached?.key === connection.key) return cached.db
      const instance = createInstance(connection, true)
      requestInstances.set(scope, instance)
      return instance.db
    }

    if (sharedInstance?.key === connection.key) return sharedInstance.db
    const previous = sharedInstance
    sharedInstance = createInstance(connection, false)
    // end() lets queries that already started finish before it closes the superseded pools.
    for (const client of previous?.clients ?? []) void client.end()
    return sharedInstance.db
  }

  // SAFETY: Every property read forwards to the Drizzle database for the active request or process.
  return new Proxy({} as RuntimePostgresDatabase<TSchema, TRelations>, {
    get(_, property) {
      // The database is not a promise. `await` reads `then`, which must not open a client.
      if (property === "then") return
      const instance = getDb()
      // Without replicas, `$replica` is the database itself, so code that reads from replicas runs everywhere.
      if (property === "$replica" && !Reflect.has(instance, "$replica")) return instance
      const value: unknown = Reflect.get(instance, property)
      // Bind Drizzle methods. Own function values such as the postgres.js `$client` keep their properties.
      return typeof value === "function" && !Object.hasOwn(instance, property) ? value.bind(instance) : value
    },
    // Drizzle's `is()` reads the prototype, so `is(db, PgAsyncDatabase)` sees the live database.
    getPrototypeOf: () => Object.getPrototypeOf(getDb()),
  })
}
