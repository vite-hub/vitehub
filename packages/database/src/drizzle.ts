import virtualSchema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb, useDatabase as useRuntimeDatabase } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase } from "./runtime/agent.ts"

import type { DatabaseDialect, RuntimeDrizzleDatabase, RuntimePostgresDatabase } from "./types.ts"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>, TDialect extends DatabaseDialect = "sqlite"> = TDialect extends "postgresql"
  ? RuntimePostgresDatabase<TSchema>
  : RuntimeDrizzleDatabase<TSchema>

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
export function useDatabase<Name extends keyof RuntimeDatabaseRegistry = DefaultDatabaseName>(
  ...name: [DefaultDatabaseName] extends [never] ? [name: Name] : [name?: Name]
): RuntimeDatabaseRegistry[Name] {
  // SAFETY: generated registry declarations type each runtime entry by its name.
  return useRuntimeDatabase(...name) as RuntimeDatabaseRegistry[Name]
}

export const agentDb = createAgentDatabase(databases)

// SAFETY: The generated registry types the default database, and the virtual schema is that database's schema.
// The package resolves `#vitehub/database/schema` through its own `imports` field, so an app cannot augment that
// module for this file. The registry is the one type source.
export const schema = virtualSchema as DefaultDatabaseEntry["schema"]
export { chunkParameters } from "./runtime/chunk-parameters.ts"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export * from "#vitehub/database/schema"
