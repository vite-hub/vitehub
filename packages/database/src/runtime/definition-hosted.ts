import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"
import { hostedLibsql } from "./hosted.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>, TRelations extends AnyRelations>(
  definition: DatabaseDefinition<TSchema, TRelations>,
): RuntimeDrizzleDatabase<TSchema, TRelations> {
  return createDrizzleSqliteAdapter<TSchema, TRelations>(runtimeConfig(definition), definition.relations, {
    libsql: hostedLibsql,
    missingConnection: "a Cloudflare D1 binding, D1 HTTP configuration, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
