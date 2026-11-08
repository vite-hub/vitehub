import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { localLibsql } from "./local-client.ts"
import { runtimeConfig } from "./definition-config.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"

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
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(config, schema, {
    libsql: localLibsql,
    missingConnection: "a Cloudflare D1 binding or `connection.url`",
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
}
