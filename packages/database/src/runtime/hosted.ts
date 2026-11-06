import { construct } from "drizzle-orm/libsql/driver-core"

import { deferLibsqlClient } from "./deferred-libsql-client.ts"
import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"

import type { Config } from "@libsql/client/http"
import type { LibsqlClientFactory } from "./drizzle-adapter.ts"
import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"

export type { RuntimeDrizzleDatabase }
export { resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

/** The libSQL factory for a remote libSQL URL. It loads `@libsql/client/http` on the first query, so a D1 app never loads it. */
export const hostedLibsql: LibsqlClientFactory = {
  createClient: (config: Config) => deferLibsqlClient("http", async () => (await import("@libsql/client/http")).createClient(config)),
  drizzle: construct,
}

export function createHostedDrizzleDb<TSchema extends Record<string, unknown>>(
  dbConfig: ResolvedDrizzleDatabaseConfig,
  schema: TSchema,
) {
  return createDrizzleSqliteAdapter(dbConfig, schema, {
    libsql: hostedLibsql,
    missingConnection: "an active Cloudflare D1 binding, `cloudflare.http` with `cloudflare.databaseId`, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
