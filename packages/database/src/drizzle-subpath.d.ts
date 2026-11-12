import "./virtual-module.d.ts"

import type { AnyRelations, EmptyRelations, ExtractTablesFromSchema, ExtractTablesWithRelations, Table } from "drizzle-orm"
import type { SQLiteAsyncDatabase } from "drizzle-orm/sqlite-core"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import virtualSchema from "#vitehub/database/schema"
import type { MergeDatabaseRelations } from "./index.js"
import type { AgentDatabaseHandle, DatabaseD1Binding } from "./runtime/agent.js"

export type { DatabaseD1Binding, DatabaseD1Result, DatabaseD1Statement } from "./runtime/agent.js"

type DatabaseDialect = "sqlite" | "postgresql"

/** Each table of the schema, as `defineRelations(schema)` returns it, so `db.query.<table>` reads one table. */
type SchemaRelations<TSchema extends Record<string, unknown>> = ExtractTablesWithRelations<EmptyRelations, ExtractTablesFromSchema<TSchema>>

type DrizzleRuntimeDatabase<TDialect extends DatabaseDialect, TRelations extends AnyRelations> = TDialect extends "postgresql"
  ? PgAsyncDatabase<PgQueryResultHKT, TRelations>
  : SQLiteAsyncDatabase<"async", unknown, TRelations>

export interface RuntimeDatabaseEntry<
  TSchema extends Record<string, unknown>,
  TDialect extends DatabaseDialect = "sqlite",
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  db: DrizzleRuntimeDatabase<TDialect, TRelations>
  /** Every table of the schema, with the relations of the Definition, its Nuxt layers, and contributed tables. */
  relations: TRelations
  schema: TSchema
}

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RegisteredDatabaseDialect<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  dialect: infer TDialect extends DatabaseDialect
} ? TDialect : "sqlite"

/**
 * A registry entry sets `relations` to one relations object, or to a list of parts that merge like Nuxt layers, lowest
 * precedence first. The generated registry lists the parts of contributed tables and of each layer.
 */
type RegisteredDatabaseRelations<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends { relations: infer TRelations }
  ? TRelations extends readonly unknown[]
    ? MergeDatabaseRelations<RegisteredDatabaseSchema<Name>, TRelations>
    : TRelations extends AnyRelations ? TRelations : SchemaRelations<RegisteredDatabaseSchema<Name>>
  : SchemaRelations<RegisteredDatabaseSchema<Name>>

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>, RegisteredDatabaseDialect<Name>, RegisteredDatabaseRelations<Name>>
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

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never

/** The Database that `useDatabase()` returns without a name: `default`, else the only one. */
type DefaultDatabaseName = "default" extends keyof RuntimeDatabaseRegistry
  ? "default"
  : true extends IsUnion<keyof RuntimeDatabaseRegistry> ? never : keyof RuntimeDatabaseRegistry

/**
 * Returns the Drizzle client and schema of a discovered Database. Without a name, it returns the `default` Database or
 * the only one. It throws `DATABASE_NOT_FOUND` for a name without a Database Definition, and `DATABASE_NAME_REQUIRED`
 * without a name when the app has several Databases and none is named `default`.
 */
export declare function useDatabase<Name extends DefaultDatabaseName = DefaultDatabaseName>(
  ...name: [DefaultDatabaseName] extends [never] ? [name: never] : []
): RuntimeDatabaseRegistry[Name]
export declare function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]

/**
 * Return the Cloudflare D1 binding of a Database, or the request's D1 session with read replication. Exposes the shared
 * prepare/batch API for consumers such as the D1 Agent Invocation store. Throws `DATABASE_NO_D1_BINDING` when the Database
 * does not run on a D1 binding here, and `DATABASE_NOT_FOUND` for an unknown name.
 */
export declare function useDatabaseBinding(name: "default" | keyof RuntimeDatabaseRegistry): DatabaseD1Binding

export declare const db: DefaultDatabaseEntry["db"]

/**
 * Applies the pending migrations of the Database `name`, or of every Database, once in this process. Parallel calls
 * share one run, and a failed run is forgotten, so the next call tries again.
 */
export declare function ensureMigrations(name?: keyof RuntimeDatabaseRegistry & string): Promise<void>

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
