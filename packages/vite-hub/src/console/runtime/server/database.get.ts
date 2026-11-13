import type { ConsoleDatabaseEntry, ConsoleDatabaseInspection } from "../../internal.ts"
import { asc, count, desc, getTableColumns, is, or, sql } from "drizzle-orm"
import { getTableConfig as getPgTableConfig, PgTable } from "drizzle-orm/pg-core"
import { getTableConfig as getSQLiteTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core"

import { consoleHttpError } from "./http-error.ts"
import { getConsoleDatabase } from "./database.ts"

import type { Column, SQL } from "drizzle-orm"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const defaultLimit = 50
const maximumLimit = 100
const maximumSearchLength = 512
const maximumCellLength = 32 * 1_024
const maximumBlobBytes = 8 * 1_024

interface ConsoleDatabaseCell {
  kind: "bigint" | "boolean" | "bytes" | "date" | "json" | "null" | "number" | "text"
  truncated?: true
  value: string
}

interface ConsoleDatabaseColumn {
  foreignKey?: { column: string; table: string }
  key: string
  name: string
  nullable: boolean
  primary: boolean
  type: string
  unique: boolean
}

interface ConsoleDatabaseTable {
  columns: ConsoleDatabaseColumn[]
  name: string
}

interface ConsoleDatabaseRelationship {
  from: { column: string; table: string }
  to: { column: string; table: string }
}

/** What a `databases.browse` call reads. Without a table, it reads only the tables. */
interface ConsoleDatabaseQuery {
  database?: string
  direction?: "asc" | "desc"
  limit?: number
  offset?: number
  search?: string
  sort?: string
  table?: string
}

export interface ConsoleDatabaseResponse {
  database: string
  databases: string[]
  direction: "asc" | "desc"
  limit: number
  offset: number
  relationships: ConsoleDatabaseRelationship[]
  rows: Array<Record<string, ConsoleDatabaseCell>>
  search: string
  sort?: string
  table?: string
  tables: ConsoleDatabaseTable[]
  total: number
}

interface DatabaseTableEntry {
  columns: Array<[string, Column]>
  name: string
  table: PgTable | SQLiteTable
}

/** The parts of the table config that the Console reads. SQLite and Postgres tables give the same shape. */
interface DatabaseTableConfig {
  columns: readonly Column[]
  foreignKeys: ReadonlyArray<{ reference(): { columns: readonly Column[], foreignColumns: readonly Column[], foreignTable: PgTable | SQLiteTable } }>
  indexes: ReadonlyArray<{ config: { columns: readonly object[], unique: boolean, where?: SQL | undefined } }>
  name: string
  primaryKeys: ReadonlyArray<{ columns: readonly Column[] }>
  uniqueConstraints: ReadonlyArray<{ columns: readonly Column[] }>
}

function tableConfig(table: PgTable | SQLiteTable): DatabaseTableConfig {
  return is(table, PgTable) ? getPgTableConfig(table) : getSQLiteTableConfig(table)
}

/** The name of an index column. SQLite indexes hold the column, Postgres indexes an indexed column, and both can hold SQL. */
function indexColumnName(column: object | undefined): string | undefined {
  return column && "name" in column && typeof column.name === "string" ? column.name : undefined
}

function requestError(statusCode: number, statusMessage: string): Error {
  return consoleHttpError(statusCode, viteHubErrorDiagnostics.VITE_HUB_R0050({ message: statusMessage }))
}

function integerParameter(value: number | undefined, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw requestError(400, `${name} must be an integer from 0 to ${maximum}.`)
  }
  return value
}

function truncate(value: string): Pick<ConsoleDatabaseCell, "truncated" | "value"> {
  return value.length > maximumCellLength
    ? { truncated: true, value: value.slice(0, maximumCellLength) }
    : { value }
}

function isDateValue(value: unknown): value is Date {
  if (value instanceof Date) return true
  try {
    Date.prototype.getTime.call(value)
    return true
  }
  catch {
    return false
  }
}

function isUint8ArrayValue(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTag !== undefined && typedArrayTag.call(value) === "Uint8Array"
}

// The intrinsic getter reads the typed array kind without trusting Symbol.toStringTag.
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get

function cell(value: unknown): ConsoleDatabaseCell {
  if (value === null || typeof value === "undefined") return { kind: "null", value: "NULL" }
  if (typeof value === "string") return { kind: "text", ...truncate(value) }
  if (typeof value === "number") return { kind: "number", value: String(value) }
  if (typeof value === "boolean") return { kind: "boolean", value: value ? "true" : "false" }
  if (typeof value === "bigint") return { kind: "bigint", value: String(value) }
  if (isDateValue(value)) return { kind: "date", value: Date.prototype.toISOString.call(value) }
  if (isUint8ArrayValue(value)) {
    const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!.call(value) as number
    const bytes = Uint8Array.prototype.subarray.call(value, 0, maximumBlobBytes)
    return {
      kind: "bytes",
      ...(byteLength > maximumBlobBytes ? { truncated: true as const } : {}),
      value: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""),
    }
  }
  try {
    const rendered = JSON.stringify(value)
    return typeof rendered === "string"
      ? { kind: "json", ...truncate(rendered) }
      : { kind: "text", ...truncate(String(value)) }
  }
  catch {
    return { kind: "text", ...truncate(String(value)) }
  }
}

function databaseTables(schema: Record<string, unknown>): DatabaseTableEntry[] {
  return Object.values(schema)
    .filter((value): value is PgTable | SQLiteTable => is(value, SQLiteTable) || is(value, PgTable))
    .map((table) => {
      // SAFETY: Drizzle's table column map contains Column values, while Object.entries only erases that value type.
      const columns = Object.entries(getTableColumns(table)) as Array<[string, Column]>
      return { columns, name: tableConfig(table).name, table }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function tableMetadata(entries: readonly DatabaseTableEntry[]): {
  relationships: ConsoleDatabaseRelationship[]
  tables: ConsoleDatabaseTable[]
} {
  const tableNames = new Map(entries.map(entry => [entry.table, entry.name]))
  const relationships: ConsoleDatabaseRelationship[] = []
  const tables = entries.map((entry) => {
    const config = tableConfig(entry.table)
    const columnKeys = new Map(entry.columns.map(([key, column]) => [column, key]))
    const primary = new Set([
      ...config.columns.filter(column => column.primary),
      ...config.primaryKeys.flatMap(key => key.columns),
    ])
    const unique = new Set([
      ...config.columns.filter(column => column.isUnique),
      ...config.uniqueConstraints.filter(constraint => constraint.columns.length === 1).flatMap(constraint => constraint.columns),
      ...config.indexes
        .filter(index => index.config.unique && !index.config.where && index.config.columns.length === 1)
        .flatMap(index => config.columns.filter(column => column.name === indexColumnName(index.config.columns[0]))),
    ])
    const foreignKeys = new Map<Column, { column: string; table: string }>()
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference()
      const foreignTable = tableNames.get(reference.foreignTable)
      if (!foreignTable) continue
      for (const [index, column] of reference.columns.entries()) {
        const foreignColumn = reference.foreignColumns[index]
        if (!foreignColumn) continue
        const target = { column: foreignColumn.name, table: foreignTable }
        foreignKeys.set(column, target)
        relationships.push({
          from: { column: column.name, table: entry.name },
          to: target,
        })
      }
    }
    return {
      columns: config.columns.flatMap((column): ConsoleDatabaseColumn[] => {
        const key = columnKeys.get(column)
        return key
          ? [{
              ...(foreignKeys.has(column) ? { foreignKey: foreignKeys.get(column) } : {}),
              key,
              name: column.name,
              nullable: !column.notNull,
              primary: primary.has(column),
              type: column.getSQLType(),
              unique: unique.has(column),
            }]
          : []
      }),
      name: entry.name,
    }
  })
  return { relationships, tables }
}

/** Reads only schema metadata. It never queries table rows. */
export function consoleDatabaseSchema(requested: string | null): {
  database: ConsoleDatabaseInspection["databases"][string]
  requestedDatabase: string
  inspection: ConsoleDatabaseInspection
  entries: DatabaseTableEntry[]
  metadata: { tables: ConsoleDatabaseTable[]; relationships: ConsoleDatabaseRelationship[] }
} {
  const inspection = getConsoleDatabase()
  if (!inspection.names.length) throw requestError(404, "No Database Definitions are configured.")

  const requestedDatabase = requested || inspection.names[0]!
  if (!inspection.names.includes(requestedDatabase)) throw requestError(404, "Database not found.")
  const database = inspection.databases[requestedDatabase]
  if (!database) throw requestError(404, "Database not found.")

  const entries = databaseTables(database.schema)
  const metadata = tableMetadata(entries)
  return { database, requestedDatabase, inspection, entries, metadata }
}

/** One page of rows of a database table, with the tables of the database, for the `databases.*` operations. */
export async function browseConsoleDatabase(query: ConsoleDatabaseQuery): Promise<ConsoleDatabaseResponse> {
  const { database, requestedDatabase, inspection, entries, metadata } = consoleDatabaseSchema(query.database ?? null)
  const requestedTable = query.table || undefined
  const entry = requestedTable ? entries.find(candidate => candidate.name === requestedTable) : undefined

  const limit = integerParameter(query.limit, "limit", defaultLimit, maximumLimit)
  if (limit < 1) throw requestError(400, `limit must be an integer from 1 to ${maximumLimit}.`)
  const offset = integerParameter(query.offset, "offset", 0, Number.MAX_SAFE_INTEGER)
  const search = (query.search || "").trim()
  if (search.length > maximumSearchLength) throw requestError(400, "search is too long.")
  const direction = query.direction === "desc" ? "desc" : "asc"
  const requestedSort = query.sort || undefined
  const sort = requestedSort && entry?.columns.some(([key]) => key === requestedSort)
    ? requestedSort
    : undefined
  if (requestedSort && !sort) throw requestError(400, "sort must name a column in the selected table.")

  let rows: Array<Record<string, unknown>> = []
  let total = 0
  if (entry) {
    const postgres = is(entry.table, PgTable)
    // SQLite has `instr` and Postgres has `strpos`. Both find the text without LIKE wildcards.
    const conditions = search
      ? or(...entry.columns.map(([, column]) => postgres
          ? sql`strpos(lower(cast(${column} as text)), lower(${search})) > 0`
          : sql`instr(lower(cast(${column} as text)), lower(${search})) > 0`))
      : undefined
    const orderColumn = entry.columns.find(([key]) => key === sort)?.[1]
      ?? entry.columns.find(([, column]) => column.primary)?.[1]
      ?? entry.columns[0]?.[1]
    // SAFETY: A Definition has one dialect, so a Postgres table comes with a Postgres database. The Postgres and SQLite
    // query builders take the same select, where, orderBy, limit, and offset calls, so the SQLite types describe both.
    const db = database.db as Extract<ConsoleDatabaseEntry["db"], { run: unknown }>
    const table = entry.table as SQLiteTable
    let rowsQuery = db.select().from(table).$dynamic()
    let countQuery = db.select({ value: count() }).from(table).$dynamic()
    if (conditions) {
      rowsQuery = rowsQuery.where(conditions)
      countQuery = countQuery.where(conditions)
    }
    if (orderColumn) rowsQuery = rowsQuery.orderBy(direction === "desc" ? desc(orderColumn) : asc(orderColumn))
    const [selectedRows, totals] = await Promise.all([
      rowsQuery.limit(limit).offset(offset),
      countQuery,
    ])
    rows = selectedRows
    total = totals[0]?.value ?? 0
  }

  return {
    database: requestedDatabase,
    databases: [...inspection.names],
    direction,
    limit,
    offset,
    relationships: metadata.relationships,
    rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)]))),
    search,
    ...(sort ? { sort } : {}),
    ...(entry ? { table: entry.name } : {}),
    tables: metadata.tables,
    total,
  }
}
