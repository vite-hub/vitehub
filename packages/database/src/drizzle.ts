import schema from "#vitehub/database/schema"
import { databases as runtimeDatabases, db as runtimeDb } from "./runtime/drizzle-runtime.ts"
import { createAgentDatabase } from "./runtime/agent.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

export const databases = runtimeDatabases as Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<typeof schema>
}

export const db = runtimeDb as DrizzleRuntimeDatabase<typeof schema>

export const agentDb = createAgentDatabase(databases)

export { schema }
export * from "#vitehub/database/schema"
