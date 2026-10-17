import schema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
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

type DefaultDatabaseEntry = "default" extends keyof RuntimeDatabaseRegistry
  ? RuntimeDatabaseRegistry["default" & keyof RuntimeDatabaseRegistry]
  : RuntimeDatabaseEntry<typeof schema>

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

export { schema }
export * from "#vitehub/database/schema"
