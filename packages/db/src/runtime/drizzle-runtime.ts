import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import type { LibSQLDatabase } from "drizzle-orm/libsql"

import config from "virtual:@vitehub/db/config"
import schema from "virtual:@vitehub/db/schema"

type DBSchema = typeof schema

let dbInstance: LibSQLDatabase<DBSchema> | undefined

function resolveSqliteUrl(url: string) {
  if (url === ":memory:") {
    return url
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^libsql:/i.test(url)) {
    return url
  }

  if (url.startsWith("file:")) {
    const path = url.slice("file:".length)
    mkdirSync(dirname(path), { recursive: true })
    return url
  }

  mkdirSync(dirname(url), { recursive: true })
  return url
}

function getDb() {
  if (dbInstance) {
    return dbInstance
  }

  const dbConfig = config?.db
  if (!dbConfig) {
    throw new Error("[vitehub] `@vitehub/db/drizzle` requires `hubDb()` and `db !== false`.")
  }

  dbInstance = drizzle({
    casing: dbConfig.drizzle.casing,
    client: createClient({
      authToken: dbConfig.connection.authToken,
      url: resolveSqliteUrl(dbConfig.connection.url),
    }),
    schema,
  })

  return dbInstance
}

export const db = new Proxy({} as LibSQLDatabase<DBSchema>, {
  get(_, prop) {
    const value = getDb()[prop as keyof LibSQLDatabase<DBSchema>]
    return typeof value === "function" ? value.bind(getDb()) : value
  },
}) as LibSQLDatabase<DBSchema>
