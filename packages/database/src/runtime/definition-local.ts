import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import { localSqlite } from "#vitehub/database/libsql"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { postgresConnectionUrl } from "./postgres-connection.ts"
import { runtimeConfig } from "./definition-config.ts"
import { warnIgnoredUrlVariable } from "./url-variables.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: DatabaseDefinition<TSchema, TRelations>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  return createConfiguredDatabase(runtimeConfig(definition, defaults), definition.relations)
}

/** The Drizzle database of a resolved config. A local file opens with libSQL, or with SQLite WASM in a WebContainer. */
export function createConfiguredDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  config: RuntimeDrizzleDatabaseConfig,
  relations: TRelations,
  migrationsDir?: string,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  if (localSqlite) warnIgnoredUrlVariable(config)
  const database = createDrizzleSqliteAdapter<TSchema, TRelations>(config, relations, {
    libsql: localSqlite,
    missingConnection: localSqlite ? "a Cloudflare D1 binding or `connection.url`" : "a Cloudflare D1 binding or `cloudflare.http`",
    requireRemoteUrl: false,
    resolveLocalUrl: localSqlite?.resolveLocalUrl,
  })
  return withTestDatabase(config.name, relations, migrationsDir, database)
}

/** Select the app test backend on each read, since imports can precede test setup. */
function withTestDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  name: string,
  relations: TRelations,
  migrationsDir: string | undefined,
  database: RuntimeDrizzleDatabase<TSchema, TRelations>,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  function current(): RuntimeDrizzleDatabase<TSchema, TRelations> {
    const test = getViteHubTestMode()
    // App tests never run a Cloudflare production build, the only build without local SQLite.
    if (!test || !localSqlite) return database
    const sqlite = localSqlite
    return test.backend(`database:${name}`, () => {
      const directory = migrationsDir ?? `server/databases/${name}/migrations`
      const client = sqlite.createTestClient(test.root, directory)
      // SAFETY: Drizzle's libSQL database is the runtime type of every SQLite Definition.
      return sqlite.drizzle(client, { relations }) as RuntimeDrizzleDatabase<TSchema, TRelations>
    }, db => (Reflect.get(db, "$client") as { close: () => void }).close())
  }
  // SAFETY: Every read goes to the current database, so the proxy has the full database shape.
  return new Proxy({} as RuntimeDrizzleDatabase<TSchema, TRelations>, {
    get: (_target, property) => property === postgresConnectionUrl ? undefined : Reflect.get(current(), property),
    getPrototypeOf: () => Object.getPrototypeOf(current()),
    has: (_target, property) => Reflect.has(current(), property),
  })
}
