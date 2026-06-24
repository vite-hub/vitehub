import { createClient } from "@libsql/client/http"
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/http"

import {
  createDrizzleSqliteAdapter,
  type RuntimeDrizzleDatabase,
} from "./drizzle-adapter.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../types.ts"

export type { RuntimeDrizzleDatabase }

export function createHostedDrizzleDb<TSchema extends Record<string, unknown>>(
  dbConfig: ResolvedDrizzleDatabaseConfig,
  schema: TSchema,
) {
  return createDrizzleSqliteAdapter(dbConfig, schema, {
    libsql: { createClient, drizzle: drizzleLibsql as never },
    missingConnectionMessage: config => `[vitehub] Hosted DB "${config.name}" requires a Cloudflare D1 binding or a remote libSQL URL. Hosted deployment requires \`db.connection.url\` to be a hosted libSQL endpoint before deploying this database to Cloudflare or Vercel.`,
    requireRemoteUrl: true,
  })
}
