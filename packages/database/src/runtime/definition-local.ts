import { createClient } from "@libsql/client"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition, defaults), definition.schema, {
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnectionMessage: config => `[vitehub] Database "${config.name}" requires a Cloudflare D1 binding or database connection URL.`,
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
}
