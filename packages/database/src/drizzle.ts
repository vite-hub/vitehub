import virtualSchema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb, useDatabase as useRuntimeDatabase } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase, createDatabaseBindingLookup } from "./runtime/agent.ts"
import { ensureDatabaseMigrations } from "./runtime/migrate-on-start.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDialect, MergeDatabaseRelations, RuntimeDrizzleDatabase, RuntimePostgresDatabase, SchemaRelations } from "./types.ts"
import type { DatabaseD1Binding } from "./runtime/agent.ts"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect, TRelations extends AnyRelations> = TDialect extends "postgresql"
  ? RuntimePostgresDatabase<TSchema, TRelations>
  : RuntimeDrizzleDatabase<TSchema, TRelations>

export interface RuntimeDatabaseEntry<
  TSchema extends Record<string, unknown>,
  TDialect extends DatabaseDialect = "sqlite",
  TRelations extends AnyRelations = SchemaRelations<TSchema>,
> {
  db: DrizzleRuntimeDatabase<TSchema, TDialect, TRelations>
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

type DefaultDatabaseEntry = RuntimeDatabaseRegistry extends { default: infer TEntry }
  ? TEntry
  : RuntimeDatabaseEntry<typeof virtualSchema>

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: DefaultDatabaseEntry
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

// SAFETY: generated registry declarations specialize the runtime database lookup by name.
export const databases = runtimeDatabases as RuntimeDatabaseLookup

// SAFETY: generated schema declarations specialize the default runtime database schema.
export const db = runtimeDb as DefaultDatabaseEntry["db"]

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
export function useDatabase<Name extends DefaultDatabaseName = DefaultDatabaseName>(
  ...name: [DefaultDatabaseName] extends [never] ? [name: never] : []
): RuntimeDatabaseRegistry[Name]
export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name]
export function useDatabase(name?: keyof RuntimeDatabaseRegistry): RuntimeDatabaseRegistry[keyof RuntimeDatabaseRegistry] {
  // SAFETY: generated registry declarations type each runtime entry by its name.
  return useRuntimeDatabase(name) as RuntimeDatabaseRegistry[keyof RuntimeDatabaseRegistry]
}

const lookupDatabaseBinding = createDatabaseBindingLookup(databases)

/**
 * Return the Cloudflare D1 binding of a Database, or the request's D1 session with read replication. Exposes the shared
 * prepare/batch API for consumers such as the D1 Agent Invocation store. Throws `DATABASE_NO_D1_BINDING` when the Database
 * does not run on a D1 binding here, and `DATABASE_NOT_FOUND` for an unknown name.
 */
export function useDatabaseBinding(name: "default" | keyof RuntimeDatabaseRegistry): DatabaseD1Binding {
  return lookupDatabaseBinding(name)
}

export const agentDb = createAgentDatabase(databases)

/**
 * Applies the pending migrations of the Database `name`, or of every Database, once in this process. It runs the same
 * path as the server start: a Postgres database migrates under the advisory lock, so other processes apply nothing
 * twice. Parallel calls share one run, and the server start shares it too. A failed run is forgotten, so the next call
 * tries again.
 *
 * @example
 * await ensureMigrations()
 */
export function ensureMigrations(name?: keyof RuntimeDatabaseRegistry & string): Promise<void> {
  // A dynamic import keeps the migration SQL out of the server start until a call needs it.
  const load = () => import("#vitehub/database/migrations").then(module => module.default)
  return ensureDatabaseMigrations({ databases, load }, name === undefined ? undefined : [name])
}

// SAFETY: The generated registry types the default database, and the virtual schema is that database's schema.
// The package resolves `#vitehub/database/schema` through its own `imports` field, so an app cannot augment that
// module for this file. The registry is the one type source.
export const schema = virtualSchema as DefaultDatabaseEntry["schema"]
export { chunkParameters } from "./runtime/chunk-parameters.ts"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export type { DatabaseD1Binding, DatabaseD1Result, DatabaseD1Statement } from "./runtime/agent.ts"
export * from "#vitehub/database/schema"
