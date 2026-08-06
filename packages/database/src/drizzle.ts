import schema from "#vitehub/database/schema"
import databaseEntries from "#vitehub/database/databases"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase } from "./runtime/agent.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

type RuntimeDatabaseRegistry = {
  [Name in keyof typeof databaseEntries]: RuntimeDatabaseEntry<typeof databaseEntries[Name]["schema"]>
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
