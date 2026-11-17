import { deferLibsqlClient } from "./deferred-libsql-client.ts"
import { createDrizzleSqliteAdapter } from "./drizzle-adapter.ts"
import { createLibsqlDrizzle } from "./libsql-drizzle.ts"

import type { Config } from "@libsql/client/http"
import type { AnyRelations } from "drizzle-orm"
import type { LibsqlClientFactory } from "./drizzle-adapter.ts"
import type { ResolvedDrizzleDatabaseConfig, RuntimeDrizzleDatabase } from "../types.ts"

export type { RuntimeDrizzleDatabase }
export { resolveRuntimeCloudflareConfig } from "../internal/cloudflare.ts"

/**
 * The libSQL factory for a remote libSQL URL. It loads `@libsql/client/http` on the first query, so a D1 app never loads it.
 * In a WebContainer, npm installs `@libsql/client-wasm`, which has no `./http` (https://github.com/stackblitz/webcontainer-core/issues/2185).
 */
export const hostedLibsql: LibsqlClientFactory = {
  createClient: (config: Config) => deferLibsqlClient("http", async () => (await import("@libsql/client/http")).createClient(config)),
  drizzle: createLibsqlDrizzle,
}

export function createHostedDrizzleDb<TRelations extends AnyRelations>(
  dbConfig: ResolvedDrizzleDatabaseConfig,
  relations: TRelations,
) {
  return createDrizzleSqliteAdapter<Record<string, unknown>, TRelations>(dbConfig, relations, {
    libsql: hostedLibsql,
    missingConnection: "an active Cloudflare D1 binding, `cloudflare.http` with `cloudflare.databaseId`, or a remote libSQL URL",
    requireRemoteUrl: true,
  })
}
