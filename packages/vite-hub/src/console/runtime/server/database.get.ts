import { asc, count, desc, getTableColumns, is, or, sql } from "drizzle-orm"
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core"

import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleDatabase } from "./database.ts"

import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import type { ConsoleRequestEvent } from "./request.ts"

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
  columns: Array<[string, SQLiteColumn]>
  name: string
  table: SQLiteTable
}

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function integerParameter(value: string | null, name: string, fallback: number, maximum: number): number {
  if (value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw requestError(400, `${name} must be an integer from 0 to ${maximum}.`)
  }
  return parsed
}

function truncate(value: string): Pick<ConsoleDatabaseCell, "truncated" | "value"> {
  return value.length > maximumCellLength
    ? { truncated: true, value: value.slice(0, maximumCellLength) }
    : { value }
}

function cell(value: unknown): ConsoleDatabaseCell {
  if (value === null || typeof value === "undefined") return { kind: "null", value: "NULL" }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database values cross driver boundaries and need a stable JSON representation.
  if (typeof value === "string") return { kind: "text", ...truncate(value) }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database values cross driver boundaries and need a stable JSON representation.
  if (typeof value === "number") return { kind: "number", value: String(value) }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Database values cross driver boundaries and need a stable JSON representation.
  if (typeof value === "boolean") return { kind: "boolean", value: value ? "true" : "false" }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON cannot serialize BigInt values, so preserve the exact decimal representation.
  if (typeof value === "bigint") return { kind: "bigint", value: String(value) }
  if (value instanceof Date) return { kind: "date", value: value.toISOString() }
  if (value instanceof Uint8Array) {
    const bytes = value.subarray(0, maximumBlobBytes)
    return {
      kind: "bytes",
      ...(value.byteLength > maximumBlobBytes ? { truncated: true as const } : {}),
      value: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""),
    }
  }
  try {
    const rendered = JSON.stringify(value)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON.stringify may return undefined for unsupported top-level database values.
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
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => {
      const config = getTableConfig(table)
      // SAFETY: Drizzle's table column map contains SQLiteColumn values, while Object.entries only erases that value type.
      const columns = Object.entries(getTableColumns(table)) as Array<[string, SQLiteColumn]>
      return { columns, name: config.name, table }
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
    const config = getTableConfig(entry.table)
    const columnKeys = new Map(entry.columns.map(([key, column]) => [column, key]))
    const primary = new Set([
      ...config.columns.filter(column => column.primary),
      ...config.primaryKeys.flatMap(key => key.columns),
    ])
    const unique = new Set([
      ...config.columns.filter(column => column.isUnique),
      ...config.uniqueConstraints.flatMap(constraint => constraint.columns),
    ])
    const foreignKeys = new Map<SQLiteColumn, { column: string; table: string }>()
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

export default async function consoleDatabaseHandler(event: ConsoleRequestEvent): Promise<ConsoleDatabaseResponse> {
  assertConsoleRequest(event, ["GET"])
  const url = consoleRequestURL(event)
  const inspection = getConsoleDatabase()
  if (!inspection.names.length) throw requestError(404, "No Database Definitions are configured.")

  const requestedDatabase = url.searchParams.get("database") || inspection.names[0]!
  if (!inspection.names.includes(requestedDatabase)) throw requestError(404, "Database not found.")
  const database = inspection.databases[requestedDatabase]
  if (!database) throw requestError(404, "Database not found.")

  const entries = databaseTables(database.schema)
  const metadata = tableMetadata(entries)
  const requestedTable = url.searchParams.get("table") || undefined
  const entry = requestedTable ? entries.find(candidate => candidate.name === requestedTable) : undefined

  const limit = integerParameter(url.searchParams.get("limit"), "limit", defaultLimit, maximumLimit)
  if (limit < 1) throw requestError(400, `limit must be an integer from 1 to ${maximumLimit}.`)
  const offset = integerParameter(url.searchParams.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER)
  const search = (url.searchParams.get("search") || "").trim()
  if (search.length > maximumSearchLength) throw requestError(400, "search is too long.")
  const direction = url.searchParams.get("direction") === "desc" ? "desc" : "asc"
  const requestedSort = url.searchParams.get("sort") || undefined
  const sort = requestedSort && entry?.columns.some(([key]) => key === requestedSort)
    ? requestedSort
    : undefined
  if (requestedSort && !sort) throw requestError(400, "sort must name a column in the selected table.")

  let rows: Array<Record<string, unknown>> = []
  let total = 0
  if (entry) {
    const conditions = search
      ? or(...entry.columns.map(([, column]) => sql`instr(lower(cast(${column} as text)), lower(${search})) > 0`))
      : undefined
    const orderColumn = entry.columns.find(([key]) => key === sort)?.[1]
      ?? entry.columns.find(([, column]) => column.primary)?.[1]
      ?? entry.columns[0]?.[1]
    let rowsQuery = database.db.select().from(entry.table).$dynamic()
    let countQuery = database.db.select({ value: count() }).from(entry.table).$dynamic()
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
