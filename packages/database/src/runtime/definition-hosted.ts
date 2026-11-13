import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"
import { hostedLibsql } from "./hosted.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, RuntimeDrizzleDatabase, RuntimeDrizzleDatabaseConfig } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: DatabaseDefinition<TSchema, TRelations>,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  return createConfiguredDatabase(runtimeConfig(definition), definition.relations)
}

/** The Drizzle database of a resolved config. A hosted runtime has no local file, so it needs a remote connection. */
export function createConfiguredDatabase<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  config: RuntimeDrizzleDatabaseConfig,
  relations: TRelations,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  return createDrizzleSqliteAdapter<TSchema, TRelations>(config, relations, {
    libsql: hostedLibsql,
    missingConnection: "a Cloudflare D1 binding, D1 HTTP configuration, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
