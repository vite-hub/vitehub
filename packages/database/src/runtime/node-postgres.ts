import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"

import { createDriverPostgresDatabase, printPostgresWarning } from "./postgres-database.ts"
import { keepOwnClient, trackNodePostgresClient } from "./request-stats.ts"

import type { AnyRelations } from "drizzle-orm"
import type { PostgresDatabaseDefinition, RuntimePostgresDatabase } from "../types.ts"
import type { LocalPostgresDatabase, PostgresDatabaseDefaults, PostgresDriverConnect } from "./postgres-database.ts"

/** Opens a node-postgres pool. `db.$client` is the `pg` Pool. */
const connectNodePostgres: PostgresDriverConnect = ({ relations, requestScoped, url }) => {
  // Cloudflare limits concurrent connections per request. Hyperdrive pools the origin connections.
  // Without a URL, `pg` reads PGUSER but needs the postgres.js PGUSERNAME alias mapped explicitly.
  const username = globalThis.process?.env.PGUSERNAME
  const pool = new pg.Pool({ ...url ? { connectionString: url } : username !== undefined ? { user: username } : {}, ...requestScoped ? { max: 5 } : {} })
  pool.on("connect", client => client.on("notice", printPostgresWarning))
  // An idle client that loses its connection emits `error` on the pool. Without a listener, Node stops the process.
  pool.on("error", error => console.error(`[vitehub] Postgres connection error: ${error.message}`))
  return { db: keepOwnClient(drizzle({ client: trackNodePostgresClient(pool), relations }), pool), end: () => pool.end() }
}

/**
 * Creates the Drizzle client for a Postgres Database Definition with node-postgres, for `driver: "node-postgres"`.
 * It follows the same rules as postgres.js: a Hyperdrive binding, then `connection.url`, then the PG* variables.
 */
export function createNodePostgresDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: PostgresDatabaseDefinition<TSchema, TRelations>,
  defaults: PostgresDatabaseDefaults,
  local?: LocalPostgresDatabase<TSchema, TRelations>,
): RuntimePostgresDatabase<TSchema, TRelations> {
  return createDriverPostgresDatabase(connectNodePostgres, definition, defaults, local)
}
