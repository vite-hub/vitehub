import { DatabaseSync } from "node:sqlite"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm"
import type { EnvDatabase } from "@vite-hub/env/database"

export function eventDatabase(path = ":memory:") {
  const sqlite = new DatabaseSync(path)
  const dialect = new SQLiteSyncDialect()
  const queries: string[] = []
  const statement = (query: SQL) => {
    const compiled = dialect.sqlToQuery(query)
    queries.push(compiled.sql)
    const params = compiled.params.map((value: unknown) => {
      if (value === null || typeof value === "number" || typeof value === "string") return value
      throw new TypeError("Unexpected SQLite parameter")
    })
    return { query: sqlite.prepare(compiled.sql), params }
  }
  const db: EnvDatabase = {
    all(query) { const compiled = statement(query); return compiled.query.all(...compiled.params) },
    run(query) { const compiled = statement(query); return compiled.query.run(...compiled.params) },
  }
  return { db, sqlite, queries }
}
