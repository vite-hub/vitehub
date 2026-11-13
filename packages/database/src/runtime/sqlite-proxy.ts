import { d1Codecs } from "drizzle-orm/d1/codecs"

import type { SqliteProxyExecutors } from "drizzle-orm/sqlite-proxy"

/**
 * Codecs for the proxy drivers. Drizzle's `sqlite-proxy` has none, so booleans, timestamps, JSON, and blobs would come
 * back as stored. Every proxy driver here returns raw SQLite values as D1 does, so it uses Drizzle's D1 codecs.
 */
export const sqliteProxyCodecs: typeof d1Codecs = d1Codecs

export type SqlMethod = "run" | "all" | "get"

/** `array`: each row is its column values in order. `object`: each row maps column names to values. */
export type SqlRowMode = "array" | "object"

export interface SqlQuery {
  sql: string
  params: unknown[]
  method: SqlMethod
  /** Default `array`. Drizzle asks for `object` rows for raw `db.all()` and `db.get()`. */
  rowMode?: SqlRowMode
}

export type SqlRow = unknown[] | Record<string, unknown>

/** `run` returns `[]`, `all` returns the rows, and `get` returns the first row or undefined. */
export type SqlResult = SqlRow[] | SqlRow | undefined

/** Builds a row of `rowMode` from the column names and values of one result row. */
export function toSqlRow(columns: readonly string[], values: ArrayLike<unknown>, rowMode: SqlRowMode | undefined): SqlRow {
  if (rowMode === "object") return Object.fromEntries(columns.map((column, index) => [column, values[index]]))
  return Array.from({ length: columns.length }, (_, index) => values[index])
}

/**
 * Drizzle's `sqlite-proxy` executors over one function that runs a query and one that runs a batch in one transaction.
 * `run` resolves to `{ rows }`, as the `sqlite-proxy` callback of Drizzle 0.x did.
 */
export function createSqlProxyExecutors(
  query: (query: SqlQuery) => Promise<SqlResult>,
  batch: (queries: SqlQuery[]) => Promise<SqlResult[]>,
): SqliteProxyExecutors {
  return {
    // SAFETY: Drizzle types each executor by row mode, and `query` returns the rows of the mode that it gets.
    all: ((sql: string, params: unknown[], rowMode?: SqlRowMode) => query({ method: "all", params, rowMode, sql })) as SqliteProxyExecutors["all"],
    // SAFETY: As for `all`. A missing row is undefined.
    get: ((sql: string, params: unknown[], rowMode?: SqlRowMode) => query({ method: "get", params, rowMode, sql })) as SqliteProxyExecutors["get"],
    run: async (sql: string, params: unknown[]) => ({ rows: await query({ method: "run", params, sql }) }),
    batch: async items => (await batch(items.map(({ method, params, rowMode, sql }) => ({ method, params, rowMode, sql }))))
      .map((result, index) => items[index]!.method === "run" ? { rows: result } : result),
  }
}
