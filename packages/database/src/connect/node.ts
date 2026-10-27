import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { connectDatabase as connect } from "../connect.ts"

import type { SQLInputValue } from "node:sqlite"
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy"
import type { ConnectDatabaseOptions, SqlDriver, SqlQuery } from "../connect.ts"

export { authTokenVariable, defaultDatabaseLocations, parseDatabaseLocation } from "../connect.ts"
export type { ConnectDatabaseOptions, DatabaseLocation, SqlDriver, SqlMethod, SqlQuery } from "../connect.ts"

/** The path of a `file:` location, relative to the working directory of the server. */
export function sqliteFilePath(path: string): string {
  return !path || path === ":memory:" ? ":memory:" : resolve(path)
}

/** A SQLite file opened with Node's built-in `node:sqlite`, so it needs no driver. Its directory is created. */
export function openSqliteFile(path: string): SqlDriver {
  const file = sqliteFilePath(path)
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true })
  const sqlite = new DatabaseSync(file)
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")

  function run({ sql, params, method }: SqlQuery): unknown[] | undefined {
    const statement = sqlite.prepare(sql)
    // SAFETY: Drizzle binds only SQLite values: text, numbers, blobs, and null.
    const values = params as SQLInputValue[]
    if (method === "run") {
      statement.run(...values)
      return []
    }
    statement.setReturnArrays(true)
    if (method !== "get") return statement.all(...values)
    const row: unknown = statement.get(...values)
    return Array.isArray(row) ? row : undefined
  }

  return {
    query: async query => run(query),
    async batch(queries) {
      sqlite.exec("BEGIN IMMEDIATE")
      try {
        const results = queries.map(run)
        sqlite.exec("COMMIT")
        return results
      }
      catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  }
}

/** `connectDatabase()` of `@vite-hub/database/connect`, which also opens `file:` locations with `node:sqlite`. */
export function connectDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(where: string | undefined, options: ConnectDatabaseOptions<TSchema> = {}): SqliteRemoteDatabase<TSchema> {
  return connect(where, { openFile: openSqliteFile, ...options })
}
