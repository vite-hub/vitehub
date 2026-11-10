import { localSqlite } from "#vitehub/database/libsql"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition, defaults), definition.schema, {
    libsql: localSqlite,
    missingConnection: localSqlite ? "a Cloudflare D1 binding or `connection.url`" : "a Cloudflare D1 binding or `cloudflare.http`",
    requireRemoteUrl: false,
    resolveLocalUrl: localSqlite?.resolveLocalUrl,
  })
}
