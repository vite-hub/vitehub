import schema from "#vitehub/database/schema"
import { sql } from "drizzle-orm"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

export const databases = runtimeDatabases as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<typeof schema>
}

export const db = runtimeDb as DrizzleRuntimeDatabase<typeof schema>

function agentDatabaseHandle(entry: RuntimeDatabaseEntry<Record<string, unknown>>) {
  return {
    exec: (statement: string) => entry.db.run(sql.raw(statement)),
    query: (statement: string) => entry.db.all(sql.raw(statement)),
    schema: () => entry.db.all(sql.raw(
      "SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )),
  }
}

const defaultAgentDatabase = agentDatabaseHandle(databases.default)

export const agentDb = {
  ...defaultAgentDatabase,
  database(name: string) {
    const entry = databases[name]
    if (!entry) throw new Error(`[vitehub] Database "${name}" is not configured.`)
    return agentDatabaseHandle(entry)
  },
}

export { schema }
export * from "#vitehub/database/schema"
