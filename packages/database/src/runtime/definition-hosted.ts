import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"
import { hostedLibsql } from "./hosted.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
): RuntimeDrizzleDatabase<TSchema> {
  return createConfiguredDatabase(runtimeConfig(definition), definition.schema)
}

/** The Drizzle database of a resolved config. A hosted runtime has no local file, so it needs a remote connection. */
export function createConfiguredDatabase<TSchema extends Record<string, unknown>>(
  config: RuntimeDrizzleDatabaseConfig,
  schema: TSchema,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(config, schema, {
    libsql: hostedLibsql,
    missingConnection: "a Cloudflare D1 binding, D1 HTTP configuration, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
