import "./virtual-module.d.ts"

import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import databaseEntries from "#vitehub/database/databases"
import schema from "#vitehub/database/schema"
import type { AgentDatabaseHandle } from "./runtime/agent.js"

type DrizzleRuntimeDatabase<TSchema extends Record<string, unknown>> = BaseSQLiteDatabase<"async", unknown, TSchema>

export interface RuntimeDatabaseEntry<TSchema extends Record<string, unknown>> {
  db: DrizzleRuntimeDatabase<TSchema>
  schema: TSchema
}

type RuntimeDatabaseRegistry = {
  [Name in keyof typeof databaseEntries]: RuntimeDatabaseEntry<typeof databaseEntries[Name]["schema"]>
}

type RuntimeDatabaseSurface = RuntimeDatabaseRegistry & {
  default: RuntimeDatabaseEntry<typeof schema>
}

type RuntimeDatabaseLookup = RuntimeDatabaseSurface & Record<string, RuntimeDatabaseEntry<Record<string, unknown>>>

export * from "#vitehub/database/schema"
export { schema }

export declare const databases: RuntimeDatabaseLookup

export declare function useDatabase<Name extends keyof RuntimeDatabaseSurface>(name: Name): RuntimeDatabaseSurface[Name]

export declare const db: DrizzleRuntimeDatabase<typeof schema>

export declare const agentDb: AgentDatabaseHandle & {
  database(name: string): AgentDatabaseHandle
}
