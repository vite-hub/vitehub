import { createClient } from "@libsql/client/http"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/http"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { runtimeConfig } from "./definition-config.ts"

import type { DatabaseDefinition, RuntimeDrizzleDatabase } from "../types.ts"

export function createDefinitionRuntime<TSchema extends Record<string, unknown>>(
  definition: DatabaseDefinition<TSchema>,
): RuntimeDrizzleDatabase<TSchema> {
  return createDrizzleSqliteAdapter(runtimeConfig(definition), definition.schema, {
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnection: "a Cloudflare D1 binding, D1 HTTP configuration, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
