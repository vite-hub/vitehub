import "./virtual-module.d.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import schema from "#vitehub/database/schema"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

export * from "#vitehub/database/schema"
export { schema }

export declare const databases: Record<string, RuntimeDatabaseEntry<Record<string, unknown>>> & {
  default: RuntimeDatabaseEntry<typeof schema>
}

export declare const db: DrizzleRuntimeDatabase<typeof schema>

export interface AgentDatabaseHandle {
  exec(statement: string): Promise<unknown>
  query(statement: string): Promise<unknown>
  schema(): Promise<unknown>
}

export declare const agentDb: AgentDatabaseHandle & {
  database(name: string): AgentDatabaseHandle
}
