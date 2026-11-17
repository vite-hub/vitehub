// The Better Auth tables that Auth adds to the app Database, built with Drizzle from the specs of `table-specs.ts`. The
// generated Database schema imports it when the server starts, and Drizzle Kit loads it to write migrations.
import { sql } from "drizzle-orm"
import { bigint as pgBigint, boolean, index as pgIndex, integer as pgInteger, jsonb, pgTable, text as pgText, timestamp, uniqueIndex as pgUniqueIndex } from "drizzle-orm/pg-core"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { authSqlName, authTableSpecs, resolveAuthTableSpecs } from "./table-specs.ts"

import type { AuthSchemaOptions, AuthTableField, AuthTableName, AuthTableSpec } from "./table-specs.ts"

export { authPluginSchemas, authTableSpecs, resolveAuthTableSpecs } from "./table-specs.ts"
export type { AuthCoreModel, AuthSchemaOptions, AuthSchemaPlugin, AuthTableField, AuthTableName, AuthTableSpec } from "./table-specs.ts"
import type { PgColumn, PgTableWithColumns } from "drizzle-orm/pg-core"
import type { SQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"

// The column builders of both dialects share these methods. Each builder returns itself, so the chain keeps one type.
interface ColumnChain<TColumn> {
  notNull(): ColumnChain<TColumn>
  unique(): ColumnChain<TColumn>
  default(value: unknown): ColumnChain<TColumn>
  $onUpdate(update: () => Date): ColumnChain<TColumn>
  references(target: () => TColumn, actions: { onDelete: "cascade" | "set null" }): ColumnChain<TColumn>
}

interface Dialect<TColumn, TTable> {
  column(name: string, field: AuthTableField): ColumnChain<TColumn>
  now: unknown
  /** The current time in milliseconds, for a `number` column. */
  nowMs: unknown
  table(name: string, columns: Record<string, ColumnChain<TColumn>>, indexes: (table: Record<string, TColumn>) => unknown[]): TTable
  index(name: string, unique: boolean, columns: TColumn[]): unknown
  id(): ColumnChain<TColumn>
}

function buildTables<TColumn, TTable>(dialect: Dialect<TColumn, TTable>, specs: Readonly<Record<string, AuthTableSpec>>): Record<string, TTable> {
  const tables: Record<string, TTable> = {}
  const tableColumns = (model: string): Record<string, TColumn> => {
    // SAFETY: Drizzle tables expose their columns as properties named by the column keys.
    return tables[model] as Record<string, TColumn>
  }
  for (const [model, spec] of Object.entries(specs)) {
    const columns: Record<string, ColumnChain<TColumn>> = { id: dialect.id() }
    const indexed: { name: string, unique: boolean, fields: readonly string[] }[] = []
    for (const [key, field] of Object.entries(spec.fields)) {
      let column = dialect.column(authSqlName(key), field)
      if (field.defaultValue !== undefined) column = column.default(field.defaultValue === "now" && field.type !== "string" ? field.type === "number" ? dialect.nowMs : dialect.now : field.defaultValue)
      if (field.onUpdate) column = column.$onUpdate(() => new Date())
      if (field.required) column = column.notNull()
      if (field.unique) column = column.unique()
      const reference = field.references
      if (reference) column = column.references(() => tableColumns(reference.model)[reference.field]!, { onDelete: reference.onDelete ?? "cascade" })
      if (field.index) indexed.push({ name: `${model}_${key}_${field.unique ? "uidx" : "idx"}`, unique: Boolean(field.unique), fields: [key] })
      columns[key] = column
    }
    for (const fields of spec.unique ?? []) indexed.unshift({ name: `${model}_${fields.join("_")}_uidx`, unique: true, fields })
    tables[model] = dialect.table(authSqlName(model), columns, table => indexed.map(entry => dialect.index(entry.name, entry.unique, entry.fields.map(field => table[field]!))))
  }
  return tables
}

/** A Better Auth table in a SQLite Database (SQLite, libSQL, or Cloudflare D1). */
export type AuthSqliteTable = SQLiteTableWithColumns<{ name: string, schema: undefined, columns: Record<string, SQLiteColumn>, dialect: "sqlite", isAlias: false }>

/** A Better Auth table in a Postgres Database. */
export type AuthPostgresTable = PgTableWithColumns<{ name: string, schema: undefined, columns: Record<string, PgColumn>, dialect: "pg", isAlias: false }>

/** The Better Auth tables for SQLite, libSQL, and Cloudflare D1. Auth adds them to the app Database. */
export type AuthSqliteSchema = Readonly<Record<AuthTableName, AuthSqliteTable>>

/** The Better Auth tables for Postgres. Auth adds them to the app Database. */
export type AuthPostgresSchema = Readonly<Record<AuthTableName, AuthPostgresTable>>

// SAFETY: Every Drizzle column builder has the chain methods; the casts give the two dialects one builder type.
const sqliteDialect: Dialect<SQLiteColumn, AuthSqliteTable> = {
  column(name, field) {
    const builder = field.type === "boolean"
      ? integer(name, { mode: "boolean" })
      : field.type === "date"
        ? integer(name, { mode: "timestamp_ms" })
        : field.type === "number"
          ? integer(name)
          : field.type === "string"
            ? text(name)
            : text(name, { mode: "json" })
    return builder as unknown as ColumnChain<SQLiteColumn>
  },
  id: () => text("id").primaryKey() as unknown as ColumnChain<SQLiteColumn>,
  index: (name, unique, columns) => (unique ? uniqueIndex(name) : index(name)).on(...columns as [SQLiteColumn, ...SQLiteColumn[]]),
  now: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  nowMs: sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
  table: (name, columns, indexes) => sqliteTable(name, columns as never, table => indexes(table as unknown as Record<string, SQLiteColumn>) as never) as unknown as AuthSqliteTable,
}

const postgresDialect: Dialect<PgColumn, AuthPostgresTable> = {
  column(name, field) {
    const builder = field.type === "boolean"
      ? boolean(name)
      : field.type === "date"
        ? timestamp(name)
        : field.type === "number"
          ? field.bigint ? pgBigint(name, { mode: "number" }) : pgInteger(name)
          : field.type === "string"
            ? pgText(name)
            : field.type === "string[]"
              ? pgText(name).array()
              : field.type === "number[]"
                ? pgInteger(name).array()
                : jsonb(name)
    return builder as unknown as ColumnChain<PgColumn>
  },
  id: () => pgText("id").primaryKey() as unknown as ColumnChain<PgColumn>,
  index: (name, unique, columns) => (unique ? pgUniqueIndex(name) : pgIndex(name)).on(...columns as [PgColumn, ...PgColumn[]]),
  now: sql`now()`,
  nowMs: sql`(extract(epoch from now()) * 1000)::bigint`,
  table: (name, columns, indexes) => pgTable(name, columns as never, table => indexes(table as unknown as Record<string, PgColumn>) as never) as unknown as AuthPostgresTable,
}

// SAFETY: `authTableSpecs` has every key of `AuthTableName`.
export const authSqliteSchema: AuthSqliteSchema = buildTables(sqliteDialect, authTableSpecs) as AuthSqliteSchema

export const authPostgresSchema: AuthPostgresSchema = buildTables(postgresDialect, authTableSpecs) as AuthPostgresSchema

/**
 * The Better Auth tables for SQLite, libSQL, and Cloudflare D1, with the plugins and additional fields of `options`. The
 * Auth Vite plugin writes a module that calls it when the Auth Definition adds fields or imports a plugin of
 * `AuthSchemaPlugin`.
 */
export function createAuthSqliteSchema(options: AuthSchemaOptions): AuthSqliteSchema & Readonly<Record<string, AuthSqliteTable>> {
  // SAFETY: `resolveAuthTableSpecs()` starts from `authTableSpecs`.
  return buildTables(sqliteDialect, resolveAuthTableSpecs(options)) as AuthSqliteSchema & Record<string, AuthSqliteTable>
}

/** The Better Auth tables for Postgres, with the plugins and additional fields of `options`. */
export function createAuthPostgresSchema(options: AuthSchemaOptions): AuthPostgresSchema & Readonly<Record<string, AuthPostgresTable>> {
  // SAFETY: `resolveAuthTableSpecs()` starts from `authTableSpecs`.
  return buildTables(postgresDialect, resolveAuthTableSpecs(options)) as AuthPostgresSchema & Record<string, AuthPostgresTable>
}
