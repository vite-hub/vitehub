import "./virtual-module.d.ts"

import type { Table } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import virtualSchema from "#vitehub/database/schema"
import type { AgentDatabaseHandle } from "./runtime/agent.js"

type DatabaseDialect = "sqlite" | "postgresql"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> = TDialect extends "postgresql"
  ? PgDatabase<PgQueryResultHKT, TSchema>
  : BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> {
  db: DrizzleRuntimeDatabase<TSchema, TDialect>
  schema: TSchema
}

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RegisteredDatabaseDialect<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  dialect: infer TDialect extends DatabaseDialect
} ? TDialect : "sqlite"

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>, RegisteredDatabaseDialect<Name>>
}

type DefaultDatabaseEntry = "default" extends keyof RuntimeDatabaseRegistry
  ? RuntimeDatabaseRegistry["default" & keyof RuntimeDatabaseRegistry]
  : RuntimeDatabaseEntry<typeof virtualSchema>

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: DefaultDatabaseEntry
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export * from "#vitehub/database/schema"

/** The schema of the default database. The generated registry gives its table types. */
export declare const schema: DefaultDatabaseEntry["schema"]

export declare const databases: RuntimeDatabaseLookup

export declare function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]

export declare const db: DefaultDatabaseEntry["db"]

export declare const agentDb: AgentDatabaseHandle & {
  database(name: string): AgentDatabaseHandle
}

export interface ChunkParametersOptions {
  /** Bound parameters that one value takes. A table counts columns for inserts binding at most one parameter per column; use a numeric count for SQL expressions with more bindings. Default `1`. */
  per?: number | Table
  /** Other bound parameters in the same statement, for example the value of an `eq()` beside the `inArray()`. Default `0`. */
  reserved?: number
  /** The most bound parameters in one statement. Default `100`, the limit of Cloudflare D1 and the lowest of the supported drivers. */
  limit?: number
}

/** Splits `values` using the caller's bound parameter counts. SQL values and SQL defaults are not inspected. */
export declare function chunkParameters<T>(values: readonly T[], options?: ChunkParametersOptions): T[][]
