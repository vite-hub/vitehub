import { getTableColumns, getTableName, is, isTable, SQL } from "drizzle-orm"
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core"

import { canonical, fingerprint, toJson } from "./canonical.ts"
import { syncErrors } from "./errors.ts"

import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import type { SyncRow } from "./protocol.ts"
import type { DefineSyncOptions, InferSyncTableRow, SyncDefinition } from "./types.ts"

/** What the server needs to know of a Sync table. */
export interface SyncTable {
  table: SQLiteTable
  /** The SQL name of the table. */
  name: string
  /** The property name of the primary key column, such as `id`. */
  key: string
  /** The columns by property name. */
  columns: Record<string, SQLiteColumn>
  /** The static defaults of the columns, as JSON. See `SyncPullResponse.defaults`. */
  defaults: SyncRow
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
  return { table, name, key, columns, defaults: staticDefaults(columns) }
}

/**
 * The `.default()` value of each column when it is a plain value, as JSON. A nullable column without a default gets
 * `null`. SQL defaults and `$defaultFn()` are left out: only the server knows their value.
 */
function staticDefaults(columns: Record<string, SQLiteColumn>): SyncRow {
  const defaults: SyncRow = {}
  for (const [name, column] of Object.entries(columns)) {
    if (column.defaultFn === undefined && column.default !== undefined && !is(column.default, SQL)) {
      const value = toJson(column.default)
      if (value !== undefined) defaults[name] = value
    }
    else if (!column.hasDefault && !column.notNull) {
      defaults[name] = null
    }
  }
  return defaults
}

const versions = new WeakMap<SQLiteTable, Promise<string>>()

/**
 * The fingerprint of a table: the SHA-256 of its SQL name, its key, and each column. It changes when a column is
 * added, removed, renamed, or changes type, and the client then drops the rows it stored.
 */
export function syncTableVersion(table: SyncTable): Promise<string> {
  let version = versions.get(table.table)
  if (!version) {
    const columns = Object.fromEntries(Object.entries(table.columns).map(([name, column]) => [name, { name: column.name, dataType: column.dataType, notNull: column.notNull }]))
    version = fingerprint(canonical({ table: table.name, key: table.key, columns }))
    versions.set(table.table, version)
  }
  return version
}

const actionName = /^[a-zA-Z]\w*$/

/**
 * A table that the browser keeps a local copy of. The browser reads and writes the copy at once, also offline, and
 * the server applies each write once, in order, as the authority. Put it in `server/sync/<name>.ts` as the default
 * export, and read it with `useSync("<name>")`.
 */
export function defineSync<const TTable, TArgs = Record<string, never>>(options: DefineSyncOptions<TTable, InferSyncTableRow<TTable>, TArgs>): SyncDefinition<TTable, InferSyncTableRow<TTable>, TArgs> {
  if (!options || typeof options !== "object") throw invalid("Pass an object with `table` and `where`.")
  const table = describeSyncTable(options.table)
  if (typeof options.where !== "function") throw invalid("`where` must be a function that returns the column values of the caller's rows, such as `({ user }) => user ? { ownerId: user.id } : false`. Return `{}` for every row.")
  const { write, schema, database, actions, live, subsets, account } = options
  if (write !== undefined && typeof write !== "boolean" && typeof write !== "function") throw invalid("`write` must be `true`, `false`, or a function that returns a boolean.")
  if (schema !== undefined) {
    const standard: unknown = Reflect.get(Object(schema), "~standard")
    if (!standard || typeof standard !== "object" || typeof Reflect.get(standard, "validate") !== "function") throw invalid("`schema` must be a Standard Schema, such as a Valibot or Zod object schema.")
  }
  if (database !== undefined && (typeof database !== "string" || !database)) throw invalid("`database` must be the name of a Database, such as `default`.")
  if (live !== undefined && typeof live !== "boolean") throw invalid("`live` must be `true` or `false`.")
  if (account !== undefined && typeof account !== "function") throw invalid("`account` must be a function that returns the caller's user id, such as `({ request }) => getUserId(request)`.")
  if (subsets !== undefined) {
    const list: unknown = subsets
    if (!Array.isArray(list)) throw invalid("`subsets` must be an array of column names, such as `[\"issueId\"]`.")
    for (const name of list) {
      if (typeof name !== "string" || !Object.hasOwn(table.columns, name)) throw invalid(`\`subsets\` has ${JSON.stringify(name)}, which is not a column of the table "${table.name}".`)
      if (name === table.key) throw invalid(`\`subsets\` cannot have the primary key \`${name}\`. A subset by key holds one row: read it from the full store.`)
    }
  }
  if (actions !== undefined) {
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) throw invalid("`actions` must be an object of functions, such as `{ complete: async ({ update }, { id }: { id: string }) => update(id, { done: true }) }`.")
    for (const [name, action] of Object.entries(actions)) {
      if (!actionName.test(name)) throw invalid(`The action name ${JSON.stringify(name)} must start with a letter and have only letters, digits, and \`_\`, such as \`complete\`.`)
      if (typeof action !== "function") throw invalid(`The action \`${name}\` must be a function \`(context, args) => result\`.`)
    }
  }
  return { "~sync": true, options }
}

export function isSyncDefinition(value: unknown): value is SyncDefinition {
  return Boolean(value) && typeof value === "object" && Reflect.get(Object(value), "~sync") === true
}
