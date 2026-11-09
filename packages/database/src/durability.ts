import { resolveConfigValue } from "./config-value.ts"

import type { Durability } from "@vite-hub/runtime/durability"
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
export function databaseDurability(input: DatabaseDurabilityInput, env: Record<string, string | undefined>): Durability[] {
  return input.databases.map((database): Durability => {
    const named = database.name === "default" ? {} : { name: database.name }
    if (database.dialect === "postgresql") return { primitive: "database", ...named, store: "postgres", scope: "shared", reason: "Postgres." }
    if (database.http) return { primitive: "database", ...named, store: "d1", scope: "shared", reason: "Cloudflare D1 over HTTP." }
    const url = resolveConfigValue(database.url, env)?.trim() ?? ""
    if (url === ":memory:" || url === "file::memory:") {
      return { primitive: "database", ...named, store: "sqlite", scope: "process", reason: "SQLite in the memory of this process.", fix }
    }
    if (/^(?:libsql|https?|wss?):/i.test(url)) return { primitive: "database", ...named, store: "libsql", scope: "shared", reason: "A remote libSQL server." }
    return { primitive: "database", ...named, store: "sqlite", scope: "host", reason: `The SQLite file ${url.replace(/^file:/, "") || "of the Database"} on this host.`, fix }
  })
}
