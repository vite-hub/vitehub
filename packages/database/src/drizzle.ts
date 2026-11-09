import virtualSchema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase } from "./runtime/agent.ts"

import type { AnyRelations } from "drizzle-orm"
import type { DatabaseDialect, MergeDatabaseRelations, RuntimeDrizzleDatabase, RuntimePostgresDatabase, SchemaRelations } from "./types.ts"

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

export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  if (Object.hasOwn(databases, name)) return databases[name]

  // SAFETY: missing runtime entries are represented as undefined by the public lookup contract.
  return undefined as unknown as RuntimeDatabaseRegistry[Name]
}

export const agentDb = createAgentDatabase(databases)

// SAFETY: The generated registry types the default database, and the virtual schema is that database's schema.
// The package resolves `#vitehub/database/schema` through its own `imports` field, so an app cannot augment that
// module for this file. The registry is the one type source.
export const schema = virtualSchema as DefaultDatabaseEntry["schema"]
export { chunkParameters } from "./runtime/chunk-parameters.ts"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export * from "#vitehub/database/schema"
