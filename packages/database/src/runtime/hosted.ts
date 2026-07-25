import { createClient } from "@libsql/client/http"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/http"

import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"

import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"

export type { RuntimeDrizzleDatabase }

export function createHostedDrizzleDb<TSchema extends Record<string, unknown>>(
  dbConfig: ResolvedDrizzleDatabaseConfig,
  schema: TSchema,
) {
  return createDrizzleSqliteAdapter(dbConfig, schema, {
    cloudflareD1Http: true,
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnectionMessage: config => `[vitehub] Hosted DB "${config.name}" requires an active Cloudflare D1 binding, cloudflare.http with databaseId, or a remote libSQL URL.`,
    requireRemoteUrl: true,
  })
}
