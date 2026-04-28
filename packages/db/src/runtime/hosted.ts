import { createClient } from "@libsql/client/http"
import { drizzle } from "drizzle-orm/libsql/http"
import type { LibSQLDatabase } from "drizzle-orm/libsql"

import type { ResolvedDrizzleDBConfig } from "../types.ts"

function isRemoteUrl(url: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^libsql:/i.test(url)
}

export function createHostedDrizzleDb<TSchema extends Record<string, unknown>>(dbConfig: ResolvedDrizzleDBConfig, schema: TSchema) {
  if (!isRemoteUrl(dbConfig.connection.url)) {
    throw new Error("[vitehub] Hosted DB outputs require a remote libSQL URL. Set `db.connection.url` to a hosted libSQL endpoint before deploying to Cloudflare or Vercel.")
  }

  let dbInstance: LibSQLDatabase<TSchema> | undefined

  function getDb() {
    if (dbInstance) {
      return dbInstance
    }

    dbInstance = drizzle({
      casing: dbConfig.drizzle.casing,
      client: createClient({
        authToken: dbConfig.connection.authToken,
        url: dbConfig.connection.url,
      }),
      schema,
    })

    return dbInstance
  }

  return new Proxy({} as LibSQLDatabase<TSchema>, {
    get(_, prop) {
      const value = getDb()[prop as keyof LibSQLDatabase<TSchema>]
      return typeof value === "function" ? value.bind(getDb()) : value
    },
  }) as LibSQLDatabase<TSchema>
}
