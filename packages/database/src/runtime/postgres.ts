import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import { createDriverPostgresDatabase, printPostgresWarning } from "./postgres-database.ts"
import { keepOwnClient, trackPostgresClient } from "./request-stats.ts"

import type { AnyRelations } from "drizzle-orm"
import type { PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"
import type { LocalPostgresDatabase, PostgresDatabaseDefaults, PostgresDriverConnect } from "./postgres-database.ts"

export type { LocalPostgresDatabase, PostgresDatabaseDefaults, PostgresDrizzle } from "./postgres-database.ts"

/** Opens a postgres.js client. `db.$client` is the postgres.js `sql` function. */
const connectPostgresJs: PostgresDriverConnect = ({ relations, requestScoped, url }) => {
  // Cloudflare limits concurrent connections per request. Hyperdrive pools the origin connections.
  // Type discovery stays on, because array columns need the type metadata that postgres.js reads.
  const options = { onnotice: printPostgresWarning, ...requestScoped ? { max: 5 } : {} }
  const client = url ? postgres(url, options) : postgres(options)
  return { db: keepOwnClient(drizzle({ client: trackPostgresClient(client), relations }), client), end: () => client.end() }
}

/**
 * Creates the Drizzle client for a Postgres Database Definition with postgres.js, the default driver.
 *
 * A Cloudflare Hyperdrive binding takes precedence over `connection.url`. With `connection.replicas`, `db.$replica`
 * reads from one replica. Inside a Cloudflare request, each request gets its own client because Workers cannot reuse
 * a socket across requests. Outside a Cloudflare request, one client pool serves the process. Without any connection,
 * `local` serves the queries.
 */
export function createPostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  defaults: PostgresDatabaseDefaults,
  local?: LocalPostgresDatabase<TRelations>,
): RuntimePostgresDatabase<TSchema, TRelations> {
  return createDriverPostgresDatabase(connectPostgresJs, definition, defaults, local)
}
