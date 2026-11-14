import { getTableColumns, getTableName, is, isTable } from "drizzle-orm"
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core"

import { syncErrors } from "./errors.ts"

import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import type { DefineSyncOptions, SyncDefinition } from "./types.ts"

/** What the server needs to know of a Sync table. */
export interface SyncTable {
  table: SQLiteTable
  /** The SQL name of the table. */
  name: string
  /** The property name of the primary key column, such as `id`. */
  key: string
  /** The columns by property name. */
  columns: Record<string, SQLiteColumn>
}

function invalid(message: string): Error {
  return syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] defineSync(): ${message}` })
}

function unsupported(message: string): Error {
  return syncErrors.SYNC_UNSUPPORTED_TABLE({ message: `[vitehub] defineSync(): ${message}` })
}

/** Reads the table of a definition, and throws when Sync cannot use it. */
export function describeSyncTable(table: unknown): SyncTable {
  if (!isTable(table)) throw invalid("`table` must be a Drizzle table, such as `sqliteTable(\"todos\", { ... })`.")
  const name = getTableName(table)
  if (!is(table, SQLiteTable)) throw unsupported(`The table "${name}" is not a SQLite table. Sync supports SQLite tables (libSQL, D1, and the local default Database) only. Postgres support comes later.`)
  const config = getTableConfig(table)
  if (config.primaryKeys.length) throw unsupported(`The table "${name}" has a composite primary key. Sync needs one primary key column of type text.`)
  // SAFETY: a SQLite table has SQLite columns only.
  const columns = getTableColumns(table) as Record<string, SQLiteColumn>
  const keys = Object.entries(columns).filter(([, column]) => column.primary)
  if (keys.length !== 1) throw unsupported(`The table "${name}" has no primary key column. Sync needs one primary key column of type text.`)
  const [key, column] = keys[0]!
  if (column.columnType !== "SQLiteText") throw unsupported(`The primary key \`${key}\` of the table "${name}" is not a text column. Sync needs a text key, because clients make new keys offline.`)
  return { table, name, key, columns }
}

/**
 * A table that the browser keeps a local copy of. The browser reads and writes the copy at once, also offline, and
 * the server applies each write once, in order, as the authority. Put it in `server/sync/<name>.ts` as the default
 * export, and read it with `useSync("<name>")`.
 */
export function defineSync<const TTable>(options: DefineSyncOptions<TTable>): SyncDefinition<TTable> {
  if (!options || typeof options !== "object") throw invalid("Pass an object with `table` and `where`.")
  describeSyncTable(options.table)
  if (typeof options.where !== "function") throw invalid("`where` must be a function that returns the column values of the caller's rows, such as `({ user }) => user ? { ownerId: user.id } : false`. Return `{}` for every row.")
  const { write, schema, database } = options
  if (write !== undefined && typeof write !== "boolean" && typeof write !== "function") throw invalid("`write` must be `true`, `false`, or a function that returns a boolean.")
  if (schema !== undefined) {
    const standard: unknown = Reflect.get(Object(schema), "~standard")
    if (!standard || typeof standard !== "object" || typeof Reflect.get(standard, "validate") !== "function") throw invalid("`schema` must be a Standard Schema, such as a Valibot or Zod object schema.")
  }
  if (database !== undefined && (typeof database !== "string" || !database)) throw invalid("`database` must be the name of a Database, such as `default`.")
  return { "~sync": true, options }
}

export function isSyncDefinition(value: unknown): value is SyncDefinition {
  return Boolean(value) && typeof value === "object" && Reflect.get(Object(value), "~sync") === true
}
