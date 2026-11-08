import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { localLibsql } from "./local-client.ts"
import { runtimeConfig } from "./definition-config.ts"
import { resolveLocalSqliteUrl } from "./local-url.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
  defaults?: Pick<DatabaseDefinition, "cloudflare" | "connection">,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition, defaults), definition.schema, {
    libsql: localLibsql,
    missingConnection: "a Cloudflare D1 binding or `connection.url`",
    requireRemoteUrl: false,
    resolveLocalUrl: resolveLocalSqliteUrl,
  })
}
