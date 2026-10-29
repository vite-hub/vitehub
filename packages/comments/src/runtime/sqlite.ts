import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { drizzle } from "drizzle-orm/sqlite-proxy"

import { commentsTables } from "../tables.ts"

import type { SQLInputValue } from "node:sqlite"
import type { CommentsDatabase } from "../store.ts"

type Method = "run" | "all" | "values" | "get"

/** `file:./data/comments.sqlite` or a plain path, relative to the working directory of the server. */
export function commentsSqlitePath(url: string): string {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  if (!path || path === ":memory:") return ":memory:"
  return resolve(path)
}

/**
 * A SQLite file that Comments opens itself with Node's built-in `node:sqlite`, so it needs no driver and no
 * migration: the tables are created when the file opens. Apps without a ViteHub Database use it.
 */
export function openCommentsSqlite(url: string): CommentsDatabase {
  const path = commentsSqlitePath(url)
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const sqlite = new DatabaseSync(path)
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
  for (const statement of commentsTables) sqlite.exec(statement)

  function execute(query: string, params: unknown[], method: Method): { rows: unknown[] } {
    const statement = sqlite.prepare(query)
    // SAFETY: Drizzle binds only the SQLite values of the columns of `commentsSchema`: text, numbers, and null.
    const values = params as SQLInputValue[]
    if (method === "run") {
      statement.run(...values)
      return { rows: [] }
    }
    statement.setReturnArrays(true)
    if (method === "all" || method === "values") return { rows: statement.all(...values) }
    // With array rows, a row is an array of column values; no row is undefined.
    const row: unknown = statement.get(...values)
    return { rows: Array.isArray(row) ? row : [] }
  }

  const database: CommentsDatabase = drizzle<Record<string, unknown>>(
    async (query, params, method) => execute(query, params, method),
    // A batch is one transaction, as it is on D1 and libSQL.
    async (queries) => {
      sqlite.exec("BEGIN IMMEDIATE")
      try {
        const results = queries.map(({ sql, params, method }) => execute(sql, params, method))
        sqlite.exec("COMMIT")
        return results
      }
      catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  )
  return database
}
