import virtualSchema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase, createDatabaseBindingLookup } from "./runtime/agent.ts"

import type { DatabaseD1Binding } from "./runtime/agent.ts"
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

export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  if (Object.hasOwn(databases, name)) return databases[name]

  // SAFETY: missing runtime entries are represented as undefined by the public lookup contract.
  return undefined as unknown as RuntimeDatabaseRegistry[Name]
}

const lookupDatabaseBinding = createDatabaseBindingLookup(databases)

/**
 * Return the Cloudflare D1 binding of a Database, or the request's D1 session with read replication. Pass it to code
 * that needs a D1 binding, such as the D1 Agent Invocation store. Throws `DATABASE_NO_D1_BINDING` when the Database
 * does not run on a D1 binding here, and `DATABASE_NOT_FOUND` for an unknown name.
 */
export function useDatabaseBinding(name: "default" | keyof RuntimeDatabaseRegistry): DatabaseD1Binding {
  return lookupDatabaseBinding(name)
}

export const agentDb = createAgentDatabase(databases)

// SAFETY: The generated registry types the default database, and the virtual schema is that database's schema.
// The package resolves `#vitehub/database/schema` through its own `imports` field, so an app cannot augment that
// module for this file. The registry is the one type source.
export const schema = virtualSchema as DefaultDatabaseEntry["schema"]
export { chunkParameters } from "./runtime/chunk-parameters.ts"
export type { ChunkParametersOptions } from "./runtime/chunk-parameters.ts"
export type { DatabaseD1Binding, DatabaseD1Result, DatabaseD1Statement } from "./runtime/agent.ts"
export * from "#vitehub/database/schema"
