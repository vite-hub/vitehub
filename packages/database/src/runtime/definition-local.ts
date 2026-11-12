import { localSqlite } from "#vitehub/database/libsql"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: DatabaseDefinition<TSchema, TRelations>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  return createDrizzleSqliteAdapter<TSchema, TRelations>(runtimeConfig(definition, defaults), definition.relations, {
    libsql: localSqlite,
    missingConnection: localSqlite ? "a Cloudflare D1 binding or `connection.url`" : "a Cloudflare D1 binding or `cloudflare.http`",
    requireRemoteUrl: false,
    resolveLocalUrl: localSqlite?.resolveLocalUrl,
  })
}
