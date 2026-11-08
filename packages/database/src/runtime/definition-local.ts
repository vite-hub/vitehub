import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { localLibsql } from "./local-client.ts"
import { runtimeConfig } from "./definition-config.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"
import { createTestDatabaseClient } from "./test-database.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema> {
  return createConfiguredDatabase(runtimeConfig(definition, defaults), definition.schema)
}

/** The Drizzle database of a resolved config. A local file opens with libSQL, or with SQLite WASM in a WebContainer. */
export function createConfiguredDatabase<TSchema extends Record<string, unknown>>(
  config: RuntimeDrizzleDatabaseConfig,
  schema: TSchema,
  migrationsDir?: string,
): RuntimeDrizzleDatabase<TSchema> {
  const database = createDrizzleSqliteAdapter(config, schema, {
    libsql: localLibsql,
    missingConnection: "a Cloudflare D1 binding or `connection.url`",
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
  return withTestDatabase(config.name, schema, migrationsDir, database)
}

/** Select the app test backend on each read, since imports can precede test setup. */
function withTestDatabase<TSchema extends Record<string, unknown>>(
  name: string,
  schema: TSchema,
  migrationsDir: string | undefined,
  database: RuntimeDrizzleDatabase<TSchema>,
): RuntimeDrizzleDatabase<TSchema> {
  function current(): RuntimeDrizzleDatabase<TSchema> {
    const test = getViteHubTestMode()
    if (!test) return database
    return test.backend(`database:${name}`, () => {
      const directory = migrationsDir ?? (name === "default" ? "server/databases/migrations" : `server/databases/${name}/migrations`)
      const client = createTestDatabaseClient(test.root, directory)
      // SAFETY: Drizzle's libSQL database is the runtime type of every SQLite Definition.
      return localLibsql.drizzle(client, { schema }) as RuntimeDrizzleDatabase<TSchema>
    }, db => (Reflect.get(db, "$client") as { close: () => void }).close())
  }
  // SAFETY: Every read goes to the current database, so the proxy has the full database shape.
  return new Proxy({} as RuntimeDrizzleDatabase<TSchema>, {
    get: (_target, property) => Reflect.get(current(), property),
    has: (_target, property) => Reflect.has(current(), property),
  })
}
