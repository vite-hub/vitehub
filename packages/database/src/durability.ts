import { classifySqliteUrl, sqliteUrlInput } from "@vite-hub/runtime/durability"

import { resolveConfigValue } from "./config-value.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"
import type { DatabaseConfigValue } from "./types.ts"

/** What the build passes to `databaseDurability()`: each Database's dialect and URL, without the auth token. */
export interface DatabaseDurabilityInput {
  databases: Array<{
    dialect: "postgresql" | "sqlite"
    /** D1 over HTTP. */
    http?: boolean
    name: string
    url?: DatabaseConfigValue
  }>
}

const fix = "Set `database.connection.url` to a remote libSQL URL, or define the Database with `dialect: \"postgresql\"`."

/** The durability of each Database. A `file:` or `:memory:` SQLite URL keeps the data on this host or in this process. */
export function databaseDurability(input: DatabaseDurabilityInput, { env }: DurabilityContext): Durability[] {
  return input.databases.map((database): Durability => {
    const named = database.name === "default" ? {} : { name: database.name }
    if (database.dialect === "postgresql") return { primitive: "database", ...named, store: "postgres", scope: "shared", reason: "Postgres." }
    if (database.http) return { primitive: "database", ...named, store: "d1", scope: "shared", reason: "Cloudflare D1 over HTTP." }
    const url = resolveConfigValue(database.url, env)?.trim() || "file:.vitehub/data/database/sqlite.db"
    const sqlite = classifySqliteUrl(url)
    return { primitive: "database", ...named, ...sqlite, ...(sqlite.scope === "shared" ? {} : { fix }) }
  })
}

/**
 * A SQLite URL for the durability input, which the build writes into the server. Environment variable names stay. A
 * remote URL, literal or as the declaration's default, becomes `remote`, so no credential reaches the bundle.
 */
export function databaseDurabilityUrl(value: DatabaseConfigValue): DatabaseConfigValue {
  if (typeof value === "string") return sqliteUrlInput(value)
  return typeof value.default === "string" ? { ...value, default: sqliteUrlInput(value.default) } : value
}
