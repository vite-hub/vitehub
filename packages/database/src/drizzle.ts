import schema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase } from "./runtime/agent.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

export interface DatabaseRegistry {}

type RegisteredDatabaseSchema<Name extends keyof DatabaseRegistry> = DatabaseRegistry[Name] extends {
  schema: infer TSchema extends Record<string, unknown>
} ? TSchema : never

type RuntimeDatabaseRegistry = {
  [Name in keyof DatabaseRegistry]: RuntimeDatabaseEntry<RegisteredDatabaseSchema<Name>>
}

type RuntimeDatabaseLookup = RuntimeDatabaseRegistry & {
  default: RuntimeDatabaseEntry<typeof schema>
} & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export const databases = runtimeDatabases as RuntimeDatabaseLookup

export const db = runtimeDb as DrizzleRuntimeDatabase<typeof schema>

export function useDatabase<Name extends keyof RuntimeDatabaseRegistry>(name: Name): RuntimeDatabaseRegistry[Name] {
  return databases[name]
}

export const agentDb = createAgentDatabase(databases)

export { schema }
export * from "#vitehub/database/schema"
