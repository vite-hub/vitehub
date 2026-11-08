import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"
import { hostedLibsql } from "./hosted.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition), definition.schema, {
    libsql: hostedLibsql,
    missingConnection: "a Cloudflare D1 binding, D1 HTTP configuration, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
